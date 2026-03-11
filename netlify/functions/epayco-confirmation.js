// netlify/functions/epayco-confirmation.js
const { createClient } = require('@supabase/supabase-js');

// Configuración - Variables de entorno
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Inicializa Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Mapa de paquetes
const packages = {
    basico: { credits: 45, name: 'Básico' },
    estandar: { credits: 90, name: 'Estándar' },
    premium: { credits: 180, name: 'Premium' },
};

exports.handler = async (event, context) => {
    console.log("========== NOTIFICACIÓN RECIBIDA ==========");
    console.log("📅 Timestamp:", new Date().toISOString());
    
    // Parsear datos
    const params = new URLSearchParams(event.body);
    const data = Object.fromEntries(params.entries());
    
    console.log("📦 Datos completos recibidos:");
    console.log(JSON.stringify(data, null, 2));

    // Extraer datos básicos
    const transactionId = data.x_ref_payco;
    const userId = data.x_extra1;
    const packageType = data.x_extra2;
    const creditsAmount = parseInt(data.x_extra3, 10);
    const amountPaid = parseFloat(data.x_amount);
    const currency = data.x_currency_code;
    const paymentMethod = data.x_franchise || data.x_bank_name || 'Otro';
    const codResponse = data.x_cod_response;
    const responseText = data.x_response;
    
    // Determinar estado
    const status = codResponse === '1' ? 'completado' : 'rechazado';

    console.log("📊 DATOS PROCESADOS:");
    console.log("   - Transaction ID:", transactionId);
    console.log("   - User ID:", userId || "❌ VACÍO");
    console.log("   - Package Type:", packageType);
    console.log("   - Credits:", creditsAmount);
    console.log("   - Amount:", amountPaid, currency);
    console.log("   - Payment Method:", paymentMethod);
    console.log("   - Cod Response:", codResponse);
    console.log("   - Response Text:", responseText);
    console.log("   - Status:", status);

    // Si no hay userId, no podemos continuar
    if (!userId) {
        console.error("❌ ERROR CRÍTICO: No se recibió userId (x_extra1 vacío)");
        return { 
            statusCode: 200, 
            body: JSON.stringify({ 
                message: "Falta userId, pero se recibió notificación",
                transaction_id: transactionId
            })
        };
    }

    try {
        // 1. VERIFICAR SI LA TRANSACCIÓN YA EXISTE
        console.log("🔍 Verificando si la transacción ya existe...");
        
        const { data: existingTransaction, error: checkError } = await supabase
            .from('transacciones')
            .select('id, status, credits_amount, user_id')
            .eq('transaction_id', transactionId)
            .maybeSingle();

        if (checkError) {
            console.error("❌ Error verificando existencia:", checkError);
        }

        // 2. SI YA EXISTE, MANEJAR SEGÚN EL CASO
        if (existingTransaction) {
            console.log("⚠️ Transacción ya existe en BD:");
            console.log("   - ID existente:", existingTransaction.id);
            console.log("   - Status existente:", existingTransaction.status);
            console.log("   - Status nuevo:", status);
            
            // Si ya existe y está completada, no hacer nada
            if (existingTransaction.status === 'completado') {
                console.log("✅ Transacción ya estaba completada. Ignorando duplicado.");
                return {
                    statusCode: 200,
                    body: JSON.stringify({ 
                        message: "Transacción ya procesada (duplicado ignorado)",
                        transaction_id: transactionId,
                        status: existingTransaction.status
                    })
                };
            }
            
            // Si existe pero no está completada (ej: rechazada antes), actualizamos
            if (existingTransaction.status !== 'completado' && status === 'completado') {
                console.log("🔄 Actualizando transacción de rechazada a completada...");
                
                const { error: updateError } = await supabase
                    .from('transacciones')
                    .update({
                        status: 'completado',
                        completed_at: new Date().toISOString(),
                        payment_method: paymentMethod,
                        amount_paid: amountPaid
                    })
                    .eq('id', existingTransaction.id);
                
                if (updateError) {
                    console.error("❌ Error actualizando transacción:", updateError);
                } else {
                    console.log("✅ Transacción actualizada correctamente");
                    
                    // Si además hay que sumar créditos (si no se sumaron antes)
                    if (status === 'completado') {
                        console.log(`💰 Verificando si ya se sumaron créditos...`);
                        
                        // Verificar si ya se sumaron (esto es más complejo, podrías tener un campo 'credits_added')
                        // Por ahora, asumimos que si la transacción existía pero no estaba completada, no se sumaron
                        
                        const { error: updateError } = await supabase.rpc('incrementar_creditos', {
                            user_id: userId,
                            cantidad: creditsAmount
                        });

                        if (updateError) {
                            console.error("❌ Error actualizando créditos:", updateError);
                        } else {
                            console.log("✅ Créditos actualizados correctamente");
                        }
                    }
                }
            }
            
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    message: "Transacción ya existía, procesada según corresponda",
                    transaction_id: transactionId
                })
            };
        }

        // 3. SI NO EXISTE, INSERTAR NUEVA
        console.log("💾 Transacción no existe, insertando nueva...");
        
        const insertData = {
            transaction_id: transactionId,
            user_id: userId,
            package_type: packageType,
            credits_amount: creditsAmount,
            amount_paid: amountPaid,
            currency: currency,
            payment_method: paymentMethod,
            status: status,
            completed_at: status === 'completado' ? new Date().toISOString() : null,
            created_at: new Date().toISOString()
        };
        
        console.log("📝 Datos a insertar:", JSON.stringify(insertData, null, 2));

        const { data: transaccion, error: transError } = await supabase
            .from('transacciones')
            .insert([insertData])
            .select()
            .single();

        if (transError) {
            // Si es error de duplicado (código 23505), ya lo manejamos
            if (transError.code === '23505') {
                console.log("⚠️ Transacción duplicada detectada en inserción (race condition)");
                return {
                    statusCode: 200,
                    body: JSON.stringify({ 
                        message: "Transacción ya existía (race condition)",
                        transaction_id: transactionId
                    })
                };
            }
            
            console.error("❌ ERROR insertando en Supabase:");
            console.error("   - Código:", transError.code);
            console.error("   - Mensaje:", transError.message);
            
            return { 
                statusCode: 500, 
                body: JSON.stringify({ 
                    error: "Error guardando en BD",
                    details: transError.message
                })
            };
        }

        console.log("✅ TRANSACCIÓN GUARDADA EXITOSAMENTE:");
        console.log("   - ID:", transaccion.id);
        console.log("   - Transaction ID:", transaccion.transaction_id);
        console.log("   - Status:", transaccion.status);

        // 4. SI ES COMPLETADO, ACTUALIZAR CRÉDITOS
        if (status === 'completado') {
            console.log(`💰 Actualizando créditos para usuario ${userId} +${creditsAmount}`);
            
            const { error: updateError } = await supabase.rpc('incrementar_creditos', {
                user_id: userId,
                cantidad: creditsAmount
            });

            if (updateError) {
                console.error("❌ ERROR ACTUALIZANDO CRÉDITOS:");
                console.error("   - Error:", updateError);
            } else {
                console.log("✅ CRÉDITOS ACTUALIZADOS CORRECTAMENTE");
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                message: "Procesado correctamente",
                status: status,
                transaction_id: transactionId
            })
        };

    } catch (error) {
        console.error("❌ ERROR GENERAL INESPERADO:");
        console.error("   - Error:", error);
        console.error("   - Stack:", error.stack);
        
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: "Error interno del servidor",
                message: error.message 
            })
        };
    }
};