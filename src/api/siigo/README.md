# Integración Siigo - Facturación Electrónica

## Descripción

Integración con la API de Siigo para la creación automática de facturas de venta cuando las órdenes de tipo `sale` se completan.

## Configuración

### 1. Variables de Entorno

Agregar las siguientes variables en tu archivo `.env`:

```env
# Siigo API Configuration
SIIGO_API_URL=https://api.siigo.com
SIIGO_USERNAME=tu_usuario_siigo
SIIGO_ACCESS_KEY=tu_access_key_siigo
SIIGO_SUBSCRIPTION_KEY=tu_subscription_key  # Opcional según plan
SIIGO_AUTO_INVOICE_ON_COMPLETE=false  # true para facturación automática
SIIGO_TEST_MODE=true  # true para pruebas sin crear facturas reales
SIIGO_INVOICE_DOCUMENT_ID=1  # ID del tipo de documento FV en Siigo
SIIGO_COST_CENTER_ID=123  # Opcional - ID del centro de costos
SIIGO_SELLER_ID=456  # Opcional - ID del vendedor
SIIGO_PAYMENT_METHOD_ID=1  # ID de la forma de pago por defecto
```

### 2. Obtener Credenciales de Siigo

1. Ingresar a Siigo Nube como **Administrador**
2. Ir a **Configuración** → **API**
3. Generar credenciales (Username y Access Key)
4. Guardar las credenciales en el `.env`

## Prerequisitos

Antes de poder crear facturas, debes asegurarte de que:

1. **Clientes sincronizados**: Los clientes deben tener `siigoId` y `identification`
2. **Productos sincronizados**: Los productos deben tener `siigoId`
3. **Taxes configurados**: Los taxes opcionales deben tener `siigoCode`

## Uso

### Facturación Automática

Cuando una orden de tipo `sale` cambia a estado `completed` y tiene un `customerForInvoice` configurado, se crea automáticamente una factura en Siigo (si `SIIGO_AUTO_INVOICE_ON_COMPLETE=true`).

### Facturación Manual

#### Crear factura para una orden específica

```bash
POST /api/siigo/create-invoice/:orderId
```

Ejemplo:
```bash
curl -X POST http://localhost:1337/api/siigo/create-invoice/123
```

Respuesta exitosa:
```json
{
  "success": true,
  "message": "Factura creada exitosamente en Siigo",
  "data": {
    "success": true,
    "order": {
      "id": 123,
      "code": "SO-251008-123"
    },
    "invoice": {
      "siigoId": "789",
      "number": "FV-001",
      "date": "2025-10-08",
      "total": 1000000
    }
  }
}
```

#### Validar si una orden puede facturarse

```bash
GET /api/siigo/validate-order/:orderId
```

Ejemplo:
```bash
curl http://localhost:1337/api/siigo/validate-order/123
```

Respuesta:
```json
{
  "success": true,
  "data": {
    "orderId": 123,
    "orderCode": "SO-251008-123",
    "canInvoice": false,
    "errors": [
      "El cliente no está sincronizado con Siigo",
      "Producto XYZ no está sincronizado con Siigo"
    ]
  }
}
```

#### Procesar todas las órdenes completadas pendientes

```bash
POST /api/siigo/process-completed-orders
```

Este endpoint busca todas las órdenes de tipo `sale` en estado `completed` que no tengan `siigoId` y las factura automáticamente.

Respuesta:
```json
{
  "success": true,
  "message": "Procesamiento completado. 5 exitosas, 2 fallidas",
  "data": {
    "processed": 7,
    "successful": 5,
    "failed": 2,
    "results": [...]
  }
}
```

#### Consultar una factura en Siigo

```bash
GET /api/siigo/invoice/:siigoId
```

#### Verificar estado de autenticación

```bash
GET /api/siigo/auth-status
```

## Estructura de Datos

### Order → Siigo Invoice

La orden debe tener:

```javascript
{
  "type": "sale",
  "state": "completed",
  "customerForInvoice": {
    "siigoId": "123",
    "identification": "900123456",
    "name": "Cliente SA",
    "paymentTerms": 30  // Días para calcular due_date
  },
  "orderProducts": [
    {
      "product": {
        "siigoId": "PROD-001",
        "name": "Producto ejemplo"
      },
      "price": 100000,
      "confirmedQuantity": 10,
      "invoicePercentage": 100  // Para facturación parcial
    }
  ],
  "totalAmount": 1000000,
  "currency": "COP",
  "notes": "Observaciones opcionales"
}
```

## Servicios

### `api::siigo.auth`

Maneja la autenticación con Siigo API.

- `getAccessToken()`: Obtiene token válido (cache de 24h)
- `invalidateToken()`: Invalida token en cache
- `getAuthHeaders()`: Retorna headers para requests

### `api::siigo.mapper`

Mapea datos de Strapi a formato Siigo.

- `mapOrderToInvoice(order)`: Convierte Order a JSON de factura Siigo
- `mapOrderProductsToItems(orderProducts)`: Mapea productos
- `validateOrderForInvoicing(order)`: Valida datos requeridos

### `api::siigo.invoice`

Crea y gestiona facturas.

- `createInvoiceForOrder(orderId)`: Crea factura para una orden
- `getInvoice(siigoId)`: Consulta factura en Siigo
- `processCompletedOrders()`: Procesa órdenes pendientes

## Manejo de Errores

Los errores comunes y sus soluciones:

### "Credenciales de Siigo no configuradas"
→ Verificar que `SIIGO_USERNAME` y `SIIGO_ACCESS_KEY` estén en `.env`

### "El cliente no tiene siigoId"
→ Sincronizar cliente con Siigo primero (crear endpoint de sincronización)

### "Producto no tiene siigoId"
→ Sincronizar producto con Siigo primero

### "Token expirado"
→ Se renueva automáticamente. Si persiste, verificar credenciales

### "La orden ya tiene una factura asociada"
→ Verificar campo `siigoId` de la orden

## Lifecycle Hook

El archivo `src/api/order/content-types/order/lifecycles.js` contiene el hook que se ejecuta después de actualizar una orden:

- Se activa cuando `state` cambia a `completed`
- Solo para orders tipo `sale`
- Solo si tiene `customerForInvoice`
- Solo si no tiene `siigoId` (no facturada)
- Solo si `SIIGO_AUTO_INVOICE_ON_COMPLETE=true`

## Logs

Los logs importantes se imprimen en consola:

```
Nuevo token de Siigo obtenido exitosamente
Iniciando creación de factura para Order ID: 123
Datos de factura mapeados: {...}
Factura creada exitosamente en Siigo. ID: 789
Order SO-251008-123 actualizada con siigoId: 789
```

## Próximos Pasos (TODO)

1. Implementar sincronización de maestros (clientes, productos)
2. Implementar creación de notas crédito para devoluciones
3. Agregar soporte para múltiples formas de pago
4. Implementar cálculo automático de taxes desde `customerForInvoice.taxes`
5. Agregar retry automático para facturas fallidas
6. Crear endpoint para anular facturas
7. Agregar notificaciones cuando falla la facturación automática

## Testing

### Modo Test (Recomendado para desarrollo)

**IMPORTANTE**: Usa el modo test para probar sin crear facturas reales en Siigo.

En tu `.env`:
```env
SIIGO_TEST_MODE=true
```

Con `SIIGO_TEST_MODE=true`:
- ✅ **No se llama a la API de Siigo** - Sin facturas reales
- ✅ **No requiere credenciales válidas** - Puedes dejar las credenciales vacías
- ✅ **Simula respuestas exitosas** - Retorna facturas falsas con ID tipo "TEST-123456"
- ✅ **Actualiza la orden** - Guarda el `siigoId` falso para testing
- ✅ **Valida toda la lógica** - Ejecuta validaciones, mapeos, etc.
- ✅ **Logs informativos** - Muestra `[TEST MODE]` en los logs

**Ejemplo de respuesta en modo test:**
```json
{
  "success": true,
  "testMode": true,
  "order": {
    "id": 123,
    "code": "SO-251008-123"
  },
  "invoice": {
    "siigoId": "TEST-1728403200000",
    "number": "FV-TEST-123",
    "date": "2025-10-08",
    "total": 1000000
  }
}
```

### Ambiente Sandbox de Siigo

Para pruebas con la API real pero en ambiente sandbox:

```env
SIIGO_TEST_MODE=false
SIIGO_API_URL=https://api-sandbox.siigo.com
SIIGO_USERNAME=tu_usuario_sandbox
SIIGO_ACCESS_KEY=tu_key_sandbox
```

### Plan de Testing Recomendado

1. **Fase 1 - Desarrollo Local** (`SIIGO_TEST_MODE=true`)
   - Crear órdenes de prueba con todos los datos
   - Validar con `GET /api/siigo/validate-order/:orderId`
   - Crear facturas test con `POST /api/siigo/create-invoice/:orderId`
   - Verificar que los datos se mapean correctamente (revisar logs)
   - Probar lifecycle automático

2. **Fase 2 - Sandbox Siigo** (`SIIGO_TEST_MODE=false` + sandbox URL)
   - Configurar credenciales de sandbox
   - Crear facturas reales en sandbox
   - Verificar facturas en Siigo Nube Sandbox
   - Probar manejo de errores

3. **Fase 3 - Producción** (solo después de validar todo)
   - Configurar credenciales de producción
   - Mantener `SIIGO_AUTO_INVOICE_ON_COMPLETE=false` inicialmente
   - Crear primeras facturas manualmente
   - Verificar en Siigo Nube producción
   - Solo entonces activar `SIIGO_AUTO_INVOICE_ON_COMPLETE=true`

## Soporte

Para más información sobre la API de Siigo:
- Documentación: https://siigoapi.docs.apiary.io/
- Portal de clientes: https://siigonube.portaldeclientes.siigo.com/
- Soporte: [email protected]
