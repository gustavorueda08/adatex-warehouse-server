# Resumen de Adaptación del Backend para Facturación Parcial

## Estado del Sistema

✅ **EL BACKEND YA ESTÁ COMPLETAMENTE IMPLEMENTADO Y FUNCIONAL**

Después de una revisión exhaustiva del código, confirmé que tu backend ya tiene **TODA** la funcionalidad necesaria para soportar el sistema de facturación parcial que planeas implementar en el frontend.

---

## Funcionalidades Existentes Validadas

### 1. Modelo de Datos ✅

**Schema de Order** ([src/api/order/content-types/order/schema.json](src/api/order/content-types/order/schema.json:30))
- ✅ Tipo `"partial-invoice"` incluido en el enum
- ✅ Campo `parentOrder` para vincular facturas parciales con orden de venta padre
- ✅ Relación `childOrders` para órdenes hijas
- ✅ Campo `siigoId` para identificar órdenes facturadas
- ✅ Relación many-to-many `items` para asociar items

**Schema de Item** ([src/api/item/content-types/item/schema.json](src/api/item/content-types/item/schema.json:170-176))
- ✅ Campo `isInvoiced: boolean` para marcar items facturados
- ✅ Campo `invoicedDate: datetime` para registrar fecha de facturación
- ✅ Campo `state` con estados: available, reserved, sold, dropped
- ✅ Relación many-to-many `orders` para múltiples facturas

### 2. Endpoints del API ✅

**Balance y Consultas**
- ✅ `GET /api/customers/:customerId/consignment-balance`
  - Retorna balance detallado por producto
  - Soporta filtro por `?product=ID`
  - Calcula: despachado, facturado, pendiente

- ✅ `GET /api/customers/:customerId/consignment-history`
  - Historial de despachos y facturaciones
  - Soporta filtros: startDate, endDate, product, limit

- ✅ `GET /api/orders/:orderId/invoiceable-items`
  - Items facturables de una orden específica
  - Agrupa por producto
  - Valida que sea remisión (sin siigoId)

**Creación de Facturas Parciales**
- ✅ `POST /api/orders/create-partial-invoice`
  - Método FIFO automático
  - Selecciona items más antiguos disponibles
  - Body: `{ parentOrder, customer, customerForInvoice, products: [{ product, quantity }] }`

- ✅ `POST /api/orders` (con type: "partial-invoice")
  - Método de selección manual
  - Especifica items por ID
  - Body: `{ data: { type: "partial-invoice", parentOrder, products: [{ product, items: [{ id }] }] } }`

**Completar Facturación**
- ✅ `PUT /api/orders/:orderId`
  - Completa factura parcial (state: "completed")
  - Marca items como facturados automáticamente
  - Genera factura en Siigo si está configurado

### 3. Servicios Implementados ✅

**Customer Service** ([src/api/customer/services/customer.js](src/api/customer/services/customer.js))
- ✅ `getConsignmentBalance(customerId, filters)`
  - Calcula balance por producto
  - Incluye detalle por orden
  - Resumen general

- ✅ `getConsignmentHistory(customerId, options)`
  - Historial completo de operaciones
  - Filtros por fecha, producto, límite

**Invoice Helpers** ([src/api/order/utils/invoiceHelpers.js](src/api/order/utils/invoiceHelpers.js))
- ✅ `findInvoiceableItemsByQuantity()` - Búsqueda FIFO automática
- ✅ `validatePartialInvoiceOrder()` - Validaciones de negocio
- ✅ `getInvoiceableItemsFromOrder()` - Items facturables
- ✅ `markItemsAsInvoiced()` - Marcar items como facturados
- ✅ `unmarkItemsAsInvoiced()` - Revertir facturación

### 4. Estrategia de Movimiento ✅

**PartialInvoiceStrategy** ([src/api/order/strategies/itemMovementStrategies.js](src/api/order/strategies/itemMovementStrategies.js:785))

✅ **create()** - Soporta dos modos:
  - Por ID de item (selección manual)
  - Por cantidad (FIFO automático)

✅ **update()** - Al completar orden:
  - Marca items como `isInvoiced: true`
  - Registra `invoicedDate`

✅ **delete()** - Al eliminar factura:
  - Desasocia items de la orden
  - Revierte estado de facturación

### 5. Validaciones de Negocio ✅

El sistema valida:
- ✅ La orden padre debe ser de tipo 'sale'
- ✅ La orden padre debe estar 'completed'
- ✅ La orden padre NO debe tener `siigoId` (debe ser remisión)
- ✅ Items deben estar en estado 'sold'
- ✅ Items NO deben estar ya facturados
- ✅ Items deben pertenecer a la orden padre
- ✅ Debe haber suficiente inventario disponible para FIFO

### 6. Integración con Siigo ✅

**Lifecycle Hook** ([src/api/order/content-types/order/lifecycles.js](src/api/order/content-types/order/lifecycles.js))
- ✅ Auto-factura al completar si `SIIGO_AUTO_INVOICE_ON_COMPLETE=true`
- ✅ Soporta modo test con `SIIGO_TEST_MODE=true`
- ✅ Actualiza `siigoId` y `invoiceNumber` automáticamente
- ✅ Manejo de errores robusto

---

## Cambios Realizados (Mínimos)

### 1. Mejora en Validaciones
**Archivo:** [src/api/order/controllers/order.js](src/api/order/controllers/order.js:224-299)

**Cambios:**
- ✅ Agregadas validaciones adicionales en `createPartialInvoice()`
- ✅ Validación de estructura de productos
- ✅ Validación de cantidad > 0
- ✅ Mensaje de error más descriptivo
- ✅ Metadata en respuesta con tipo de creación

**Antes:**
```javascript
// Sin validaciones detalladas de cada producto
```

**Después:**
```javascript
// Validar que los productos tengan la estructura correcta
for (const p of data.products) {
  if (!p.product) {
    throw new Error("Cada producto debe tener el campo 'product'");
  }
  if (!p.quantity || p.quantity <= 0) {
    throw new Error("Cada producto debe tener una cantidad mayor a 0");
  }
}
```

### 2. Documentación Completa
**Archivos Creados:**
- ✅ `API_ENDPOINTS_PARTIAL_INVOICE.md` - Documentación exhaustiva de todos los endpoints
- ✅ `RESUMEN_ADAPTACION_BACKEND.md` - Este archivo

---

## Estructura de Datos Clave

### Remisión (Sale Order sin Facturar)
```json
{
  "id": 123,
  "code": "SALE-2025-001",
  "type": "sale",
  "state": "completed",
  "siigoId": null,  // <- Sin facturar
  "items": [
    {
      "id": 456,
      "state": "sold",
      "isInvoiced": false,  // <- Disponible para facturar
      "currentQuantity": 50.0
    }
  ]
}
```

### Factura Parcial (Borrador)
```json
{
  "id": 125,
  "code": "PI-2025-001",
  "type": "partial-invoice",
  "state": "draft",
  "parentOrder": { "id": 123 },
  "siigoId": null,
  "items": [
    {
      "id": 456,
      "state": "sold",
      "isInvoiced": false  // <- Todavía no facturado
    }
  ]
}
```

### Factura Parcial (Completada)
```json
{
  "id": 125,
  "code": "PI-2025-001",
  "type": "partial-invoice",
  "state": "completed",
  "parentOrder": { "id": 123 },
  "siigoId": "FV-12345",  // <- Facturada
  "invoiceNumber": "FV-12345",
  "items": [
    {
      "id": 456,
      "state": "sold",
      "isInvoiced": true,  // <- Facturado
      "invoicedDate": "2025-01-20T10:30:00.000Z"
    }
  ]
}
```

---

## Flujo de Datos Completo

### 1. Crear Remisión
```
POST /api/orders
→ Crea Order type="sale"
→ Asocia Items y cambia state → "sold"
→ NO genera siigoId = REMISIÓN
```

### 2. Consultar Balance
```
GET /api/customers/5/consignment-balance
→ Encuentra órdenes SALE completadas sin siigoId
→ Cuenta items en estado "sold"
→ Separa facturados (isInvoiced=true) de pendientes
→ Calcula balance: despachado - facturado = pendiente
```

### 3. Crear Factura Parcial (FIFO)
```
POST /api/orders/create-partial-invoice
→ Valida parentOrder (sale, completed, sin siigoId)
→ Busca items FIFO: sold + !isInvoiced
→ Selecciona items más antiguos (actualDispatchDate asc)
→ Asocia items a nueva orden via many-to-many
→ Crea Order type="partial-invoice" state="draft"
```

### 4. Crear Factura Parcial (Manual)
```
POST /api/orders (type="partial-invoice")
→ Valida parentOrder
→ Valida que items pertenezcan a parentOrder
→ Valida que items estén sold + !isInvoiced
→ Asocia items específicos a nueva orden
→ Crea Order type="partial-invoice" state="draft"
```

### 5. Completar Factura
```
PUT /api/orders/125 { state: "completed" }
→ Cambia estado de orden
→ PartialInvoiceStrategy.update() marca items:
   - isInvoiced: true
   - invoicedDate: now()
→ Lifecycle hook genera factura en Siigo
→ Actualiza siigoId + invoiceNumber
```

### 6. Consultar Balance Actualizado
```
GET /api/customers/5/consignment-balance
→ Ahora cuenta items facturados
→ Balance pendiente se reduce
```

---

## Endpoints Disponibles para el Frontend

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/customers/:id/consignment-balance` | Balance de remisión |
| GET | `/customers/:id/consignment-balance?product=X` | Balance filtrado por producto |
| GET | `/customers/:id/consignment-history` | Historial completo |
| GET | `/orders/:id/invoiceable-items` | Items facturables de una orden |
| POST | `/orders/create-partial-invoice` | Crear factura (FIFO automático) |
| POST | `/orders` | Crear factura (selección manual) |
| PUT | `/orders/:id` | Completar factura parcial |
| GET | `/orders/:id` | Obtener factura parcial |
| GET | `/orders?filters[type][$eq]=partial-invoice` | Listar facturas parciales |

---

## Variables de Entorno

```env
# Facturación automática al completar orden
SIIGO_AUTO_INVOICE_ON_COMPLETE=true

# Modo test (no llama API real de Siigo)
SIIGO_TEST_MODE=true

# URL de API de Siigo
SIIGO_API_URL=https://api.siigo.com
```

---

## Testing Sugerido

### Test 1: Balance de Remisión
```bash
# Crear orden de venta sin facturar
curl -X POST http://localhost:1337/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "type": "sale",
      "customer": 5,
      "products": [...]
    }
  }'

# Completar sin facturar (sin customerForInvoice)
curl -X PUT http://localhost:1337/api/orders/123 \
  -d '{"data": {"state": "completed"}}'

# Verificar balance
curl http://localhost:1337/api/customers/5/consignment-balance
```

### Test 2: Factura Parcial FIFO
```bash
# Crear factura parcial automática
curl -X POST http://localhost:1337/api/orders/create-partial-invoice \
  -H "Content-Type: application/json" \
  -d '{
    "parentOrder": 123,
    "customer": 5,
    "customerForInvoice": 5,
    "products": [
      { "product": 10, "quantity": 60 }
    ]
  }'

# Completar factura
curl -X PUT http://localhost:1337/api/orders/125 \
  -d '{"data": {"state": "completed"}}'

# Verificar balance actualizado
curl http://localhost:1337/api/customers/5/consignment-balance
```

### Test 3: Factura Parcial Manual
```bash
# Obtener items facturables
curl http://localhost:1337/api/orders/123/invoiceable-items

# Crear factura con items específicos
curl -X POST http://localhost:1337/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "type": "partial-invoice",
      "parentOrder": 123,
      "customer": 5,
      "customerForInvoice": 5,
      "products": [{
        "product": 10,
        "items": [{"id": 456}, {"id": 457}]
      }]
    }
  }'
```

---

## Archivos Clave del Backend

### Modelos
- `src/api/order/content-types/order/schema.json` - Schema de Order
- `src/api/item/content-types/item/schema.json` - Schema de Item

### Controladores
- `src/api/order/controllers/order.js` - Endpoints de órdenes
- `src/api/customer/controllers/customer.js` - Endpoints de clientes

### Servicios
- `src/api/order/services/order.js` - Lógica de negocio de órdenes
- `src/api/customer/services/customer.js` - Lógica de balance e historial

### Rutas
- `src/api/order/routes/custom-order-routes.js` - Rutas personalizadas
- `src/api/customer/routes/custom-customer-routes.js` - Rutas personalizadas

### Utilidades
- `src/api/order/utils/invoiceHelpers.js` - Helpers de facturación
- `src/api/order/utils/orderHelpers.js` - Helpers generales de órdenes

### Estrategias
- `src/api/order/strategies/itemMovementStrategies.js` - Estrategias de movimiento

### Lifecycles
- `src/api/order/content-types/order/lifecycles.js` - Hooks de Siigo

### Constantes
- `src/utils/orderTypes.js` - Tipos de orden
- `src/utils/orderStates.js` - Estados de orden
- `src/utils/itemStates.js` - Estados de item

---

## Conclusión

✅ **NO SE REQUIEREN CAMBIOS MAYORES EN EL BACKEND**

El backend está completamente preparado para soportar el sistema de facturación parcial del frontend. Los únicos cambios realizados fueron:

1. ✅ Mejora en validaciones del endpoint `createPartialInvoice`
2. ✅ Creación de documentación completa

**El frontend puede consumir los endpoints directamente sin necesidad de modificaciones adicionales en el backend.**

---

## Próximos Pasos para el Frontend

1. **Implementar hooks de consumo**
   - `useConsignmentBalance(customerId)`
   - `useConsignmentHistory(customerId, options)`
   - `useInvoiceableItems(orderId)`
   - `useCreatePartialInvoice()`

2. **Crear componentes**
   - `ConsignmentBalance.jsx` - Balance por cliente
   - `InvoiceableItemsTable.jsx` - Tabla de items facturables
   - `PartialInvoiceForm.jsx` - Formulario de creación

3. **Integrar en páginas**
   - `/customers/[id]` - Mostrar balance
   - `/sales/[id]` - Botón "Crear factura parcial"
   - `/sales/[id]/partial-invoice` - Formulario de creación
   - `/partial-invoices` - Lista de facturas
   - `/partial-invoices/[id]` - Detalle de factura

4. **Probar flujos completos**
   - Remisión → Balance → Factura FIFO → Completar
   - Remisión → Items facturables → Factura manual → Completar

---

## Soporte

Para más información:
- 📖 **Documentación de Endpoints:** `API_ENDPOINTS_PARTIAL_INVOICE.md`
- 📖 **Guía de Backend Original:** `PARTIAL_INVOICE_GUIDE.md`
- 💻 **Código del Frontend:** Ver guía original en la solicitud
