// netlify/functions/epayco-confirmation.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Configuración - ¡NO SUBIR ESTOS VALORES A GITHUB!
// Es mejor usar variables de entorno en Netlify.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zicowjlhaopgamhesqcz.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // NECESITAS UNA SERVICE ROLE KEY
const EPAYCO_CUST_ID_CLIENTE = process.env.EPAYCO_CUST_ID_CLIENTE; // Lo obtienes de ePayco
const EPAYCO_P_KEY = process.env.EPAYCO_P_KEY; // Tu llave privada de ePayco

// Inicializa Supabase con la SERVICE ROLE KEY para evitar políticas de seguridad (RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Mapa de paquetes
const packages = {
    basico: { credits: 45, name: 'Básico' },
    estandar: { credits: 90, name: 'Estándar' },
    premium: { credits: 180, name: 'Premium' },
};

exports.handler = async (event, context) => {
    // ePayco envía los datos como x-www-form-urlencoded, no como JSON
    const params = new URLSearchParams(event.body);
    const data = Object.fromEntries(params.entries());

    console.log("--- Notificación recibida de ePayco ---");
    // console.log("Datos completos:", data); // Descomentar para depurar, pero ten cuidado con datos sensibles

    // 1. VALIDACIÓN DE FIRMA (¡CRUCIAL!)
    const firmaRecibida = data.x_signature;
    if (!firmaRecibida) {
        console.error("Error: No se recibió firma.");
        return { statusCode: 400, body: 'Firma no proporcionada' };
    }

    // La cadena a firmar es: llavePrivada~custIdCliente~refPayco~monto~impuesto~moneda
    const cadenaFirmar = `${EPAYCO_P_KEY}~${data.x_cust_id_cliente}~${data.x_ref_payco}~${data.x_amount}~${data.x_tax}~${data.x_currency_code}`;
    const firmaCalculada = crypto.createHash('sha256').update(cadenaFirmar).digest('hex');

    console.log("Firma Recibida:", firmaRecibida);
    console.log("Firma Calculada:", firmaCalculada);

    if (firmaRecibida !== firmaCalculada) {
        console.error("Error: Firma inválida. Posible intento de fraude.");
        return { statusCode: 401, body: 'Firma inválida' };
    }
    console.log("Firma válida. Continuando...");

    // 2. VERIFICAR ESTADO DE LA TRANSACCIÓN
    // Aceptada: cod_response=1, estado: Aceptada
    if (data.x_cod_response !== '1') {
        console.log(`Transacción no fue aceptada. Código: ${data.x_cod_response}, Estado: ${data.x_response}`);
        // Aún así, podrías guardarla como 'rechazada' en tu BD para tener un registro.
        // Pero por ahora, solo responderemos 200 para que ePayco no reintente.
        return { statusCode: 200, body: 'Transacción no aceptada, no se acreditaron créditos' };
    }

    // 3. EXTRAER DATOS
    const transactionId = data.x_ref_payco;
    const userId = data.x_extra1; // ¡Aquí está nuestro userId!
    const packageType = data.x_extra2;
    const creditsAmount = parseInt(data.x_extra3, 10);
    const amountPaid = parseFloat(data.x_amount);
    const currency = data.x_currency_code;
    const paymentMethod = data.x_bank_name || data.x_franchise || 'Otro';
    const customerEmail = data.x_customer_email;

    if (!userId) {
        console.error("Error: No se recibió userId (x_extra1)");
        return { statusCode: 400, body: 'Falta userId' };
    }

    // 4. VERIFICAR DATOS DEL PAQUETE
    const packageInfo = packages[packageType];
    if (!packageInfo || packageInfo.credits !== creditsAmount) {
        console.error(`Error: Datos de paquete inconsistentes. Recibido: ${packageType} - ${creditsAmount} créditos.`);
        return { statusCode: 400, body: 'Datos de paquete inválidos' };
    }

    // 5. GUARDAR EN SUPABASE (TODO EN UNA SOLA TRANSACCIÓN)
    try {
        // Iniciamos una operación en la base de datos
        const { data: transaccion, error: transError } = await supabase
            .from('transacciones')
            .insert({
                transaction_id: transactionId,
                user_id: userId,
                package_type: packageType,
                credits_amount: creditsAmount,
                amount_paid: amountPaid,
                currency: currency,
                payment_method: paymentMethod,
                status: 'completado', // 'pendiente', 'completado', 'rechazado'
                completed_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (transError) {
            // Podría ser un error de duplicado (la transacción ya se insertó antes)
            if (transError.code === '23505') { // Código de error por unique violation
                console.log(`Transacción ${transactionId} ya existía. Ignorando duplicado.`);
            } else {
                throw new Error(`Error al insertar transacción: ${transError.message}`);
            }
        } else {
            console.log(`Transacción ${transactionId} guardada correctamente.`);

            // 6. ACTUALIZAR CRÉDITOS DEL USUARIO (¡SOLO SI SE INSERTO LA TRANSACCIÓN!)
            const { error: updateError } = await supabase.rpc('incrementar_creditos', {
                user_id: userId,
                cantidad: creditsAmount
            });

            if (updateError) {
                // Esto es grave. La transacción se guardó pero los créditos no se sumaron.
                // Deberías tener un sistema de logging y alertas para esto.
                console.error(`¡¡¡CRÍTICO!!! Pago aceptado pero no se pudieron sumar créditos. User: ${userId}, Trans: ${transactionId}, Error: ${updateError.message}`);
                // Podrías incluso enviar un correo de alerta al administrador.
            } else {
                console.log(`Créditos actualizados para usuario ${userId}. Se añadieron ${creditsAmount}.`);
            }
        }

        // 7. RESPONDER A EPAYCO
        return {
            statusCode: 200,
            body: 'Notificación procesada correctamente',
        };

    } catch (error) {
        console.error("Error fatal en la función:", error);
        return {
            statusCode: 500,
            body: 'Error interno del servidor',
        };
    }
};