# Guía de Facturación Parcial e Inventario en Remisión

## Descripción

El sistema de **facturación parcial** permite gestionar el inventario despachado a clientes en **remisión** (sin facturar inicialmente), para luego facturar parcialmente según el cliente reporte qué productos vendió.

Este flujo es útil cuando:
- Despachas productos a un cliente sin facturar (remisión)
- El cliente te reporta periódicamente qué productos vendió
- Necesitas facturar solo lo vendido, dejando el resto en remisión
- Requieres control detallado del inventario en poder del cliente

## Conceptos Clave

### Orden de Venta (type: "sale")
- Despacha productos al cliente
- Cambia items de `available` → `sold`
- **SIN facturar**: no tiene `siigoId`
- Es una **remisión**

### Orden de Facturación Parcial (type: "partial-invoice")
- NO mueve inventario físico
- Solo asocia items ya despachados para facturar
- Genera `siigoId` al completarse
- Marca items como `isInvoiced: true`
- Se ancla a la orden padre mediante `parentOrder`

### Balance de Remisión
- **Total despachado**: Items en estado `sold`
- **Total facturado**: Items con `isInvoiced: true`
- **Pendiente**: Despachado - Facturado

## Flujo Completo

### 1. Crear Orden de Venta sin Facturar

```http
POST /api/orders
Content-Type: application/json

{
  "data": {
    "type": "sale",
    "customer": 5,
    "sourceWarehouse": 1,
    "state": "draft",
    "products": [{
      "product": 10,
      "requestedQuantity": 100,
      "items": [{
        "barcode": "ITEM-001",
        "warehouse": 1
      }]
    }]
  }
}
```

**Completar la orden (despachar):**

```http
PUT /api/orders/:orderId
Content-Type: application/json

{
  "data": {
    "state": "completed",
    "actualDispatchDate": "2025-01-15"
  }
}
```

**Resultado:**
- Item cambia a estado `sold`
- Orden NO tiene `siigoId` (es remisión)
- Inventario queda en poder del cliente

### 2. Consultar Balance de Remisión

**Por cliente:**

```http
GET /api/customers/:customerId/consignment-balance
```

**Respuesta:**

```json
{
  "data": {
    "customer": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "products": [{
      "product": {
        "id": 10,
        "name": "Producto A",
        "code": "PROD-A",
        "unit": "kg"
      },
      "totalDispatched": 100,
      "totalInvoiced": 50,
      "pendingBalance": 50,
      "orders": [{
        "orderId": 123,
        "orderCode": "SA-250115-1",
        "dispatchDate": "2025-01-15",
        "invoiced": false,
        "dispatched": 100,
        "invoicedQty": 50,
        "pending": 50
      }]
    }],
    "summary": {
      "totalDispatched": 100,
      "totalInvoiced": 50,
      "totalPending": 50
    }
  }
}
```

**Filtrar por producto:**

```http
GET /api/customers/:customerId/consignment-balance?product=10
```

### 3. Consultar Items Facturables de una Orden

```http
GET /api/orders/:parentOrderId/invoiceable-items
```

**Respuesta:**

```json
{
  "data": {
    "order": {
      "id": 123,
      "code": "SA-250115-1",
      "dispatchDate": "2025-01-15",
      "customer": {
        "id": 5,
        "name": "Cliente ABC"
      }
    },
    "products": [{
      "product": {
        "id": 10,
        "name": "Producto A",
        "code": "PROD-A",
        "unit": "kg"
      },
      "totalQuantity": 50,
      "itemCount": 2,
      "items": [{
        "id": 456,
        "barcode": "ITEM-001",
        "quantity": 30,
        "lotNumber": "LOT-2025-01",
        "state": "sold"
      }, {
        "id": 457,
        "barcode": "ITEM-002",
        "quantity": 20,
        "lotNumber": "LOT-2025-01",
        "state": "sold"
      }]
    }],
    "summary": {
      "totalProducts": 1,
      "totalItems": 2
    }
  }
}
```

### 4. Crear Orden de Facturación Parcial

#### Opción A: Especificando Items por ID

```http
POST /api/orders
Content-Type: application/json

{
  "data": {
    "type": "partial-invoice",
    "parentOrder": 123,
    "customerForInvoice": 5,
    "notes": "Facturación parcial - 30 kg vendidos",
    "products": [{
      "product": 10,
      "requestedQuantity": 30,
      "items": [{
        "id": 456
      }]
    }]
  }
}
```

#### Opción B: Búsqueda Automática por Cantidad (FIFO)

```http
POST /api/orders/create-partial-invoice
Content-Type: application/json

{
  "parentOrder": 123,
  "customer": 5,
  "customerForInvoice": 5,
  "notes": "Facturación automática - 30 kg",
  "products": [{
    "product": 10,
    "quantity": 30
  }]
}
```

**¿Qué hace?**
- Busca automáticamente items del `producto 10` despachados al `cliente 5`
- Aplica **FIFO** (First In, First Out): items más antiguos primero
- Selecciona items hasta cubrir `30 kg`
- Puede usar múltiples items si es necesario

**Resultado:**
- Orden `type: "partial-invoice"` creada
- Items asociados a la nueva orden (relación many-to-many)
- Items **NO cambian de estado** (siguen `sold`)

### 5. Completar y Facturar

```http
PUT /api/orders/:partialInvoiceOrderId
Content-Type: application/json

{
  "data": {
    "state": "completed",
    "completedDate": "2025-01-20"
  }
}
```

**Al completarse:**
1. Items se marcan como `isInvoiced: true` e `invoicedDate: now()`
2. Si `SIIGO_AUTO_INVOICE_ON_COMPLETE=true`, se genera automáticamente la factura en Siigo
3. La orden obtiene su `siigoId` y `invoiceNumber`

### 6. Consultar Histórico de Remisiones

```http
GET /api/customers/:customerId/consignment-history?startDate=2025-01-01&endDate=2025-01-31&product=10&limit=50
```

**Respuesta:**

```json
{
  "data": [{
    "date": "2025-01-15",
    "type": "dispatch",
    "orderId": 123,
    "orderCode": "SA-250115-1",
    "product": {
      "id": 10,
      "name": "Producto A",
      "code": "PROD-A"
    },
    "quantity": 100,
    "invoiced": false,
    "siigoId": null
  }, {
    "date": "2025-01-20",
    "type": "invoice",
    "orderId": 456,
    "orderCode": "PI-250120-1",
    "product": {
      "id": 10,
      "name": "Producto A",
      "code": "PROD-A"
    },
    "quantity": 30,
    "invoiced": true,
    "siigoId": "SIIGO-789",
    "parentOrderId": 123,
    "parentOrderCode": "SA-250115-1"
  }],
  "meta": {
    "count": 2
  }
}
```

## Múltiples Facturaciones Parciales

Puedes crear varias órdenes `partial-invoice` desde la misma orden padre:

```
Orden de Venta (SA-001): 100 kg despachados
  │
  ├─ Orden Factura Parcial 1 (PI-001): 30 kg facturados
  │
  ├─ Orden Factura Parcial 2 (PI-002): 40 kg facturados
  │
  └─ Pendiente: 30 kg aún en remisión
```

Cada orden parcial:
- Tiene su propio `siigoId`
- Factura solo los items especificados
- Mantiene trazabilidad con `parentOrder`

## Campos del Schema

### Order
```json
{
  "type": "partial-invoice",     // Nuevo tipo
  "parentOrder": 123,             // Referencia a orden padre
  "siigoId": "SIIGO-123",         // ID de factura en Siigo
  "invoiceNumber": "FV-001",      // Número de factura
  "customerForInvoice": 5         // Cliente para facturar
}
```

### Item
```json
{
  "state": "sold",                // Estado del item
  "isInvoiced": true,             // Flag de facturación
  "invoicedDate": "2025-01-20"    // Fecha de facturación
}
```

## Validaciones

### Al Crear Orden Partial-Invoice

✅ La orden padre debe ser tipo `sale`
✅ La orden padre debe estar `completed`
✅ La orden padre NO debe tener `siigoId` (debe ser remisión)
✅ Los items deben pertenecer a órdenes del cliente
✅ Los items deben estar en estado `sold`
✅ Los items NO deben estar ya facturados (`isInvoiced: false`)

### Al Buscar Items por Cantidad

✅ Debe haber suficiente inventario en remisión
✅ Se aplica FIFO por fecha de despacho
❌ Lanza error si no hay suficiente inventario disponible

## Códigos de Orden

Las órdenes de facturación parcial tienen el prefijo **"PI"**:
- Formato: `PI-YYMMDD-N`
- Ejemplo: `PI-250120-1` (primera factura parcial del 20 de enero de 2025)

## Reversión

Al eliminar una orden `partial-invoice` (solo en estado draft/confirmed):

1. Se desasocian los items de la orden
2. Se revierte `isInvoiced: false` e `invoicedDate: null`
3. Los items vuelven a estar disponibles para facturación
4. NO se revierte el despacho físico (items siguen en estado `sold`)

## Casos de Uso

### Caso 1: Consignación Simple

**Escenario:** Despachas 100 unidades, el cliente vende 60, te reporta y facturas.

```bash
# 1. Despachar (remisión)
POST /api/orders → type: "sale", state: "completed", sin siigoId

# 2. Cliente reporta venta de 60 unidades
POST /api/orders/create-partial-invoice
{
  "parentOrder": 123,
  "products": [{ "product": 10, "quantity": 60 }]
}

# 3. Completar y facturar
PUT /api/orders/:partialInvoiceOrderId → state: "completed"

# 4. Consultar balance
GET /api/customers/:customerId/consignment-balance
# → Pendiente: 40 unidades
```

### Caso 2: Facturación Progresiva

**Escenario:** El cliente vende gradualmente y reporta semanalmente.

```bash
# Semana 1: Cliente vende 20 unidades
POST /api/orders/create-partial-invoice
{ "products": [{ "product": 10, "quantity": 20 }] }

# Semana 2: Cliente vende 30 unidades más
POST /api/orders/create-partial-invoice
{ "products": [{ "product": 10, "quantity": 30 }] }

# Consultar balance actualizado
GET /api/customers/:customerId/consignment-balance
```

### Caso 3: Múltiples Productos

**Escenario:** Despachas varios productos, el cliente vende algunos de cada uno.

```bash
POST /api/orders/create-partial-invoice
{
  "parentOrder": 123,
  "products": [
    { "product": 10, "quantity": 30 },
    { "product": 11, "quantity": 15 },
    { "product": 12, "quantity": 50 }
  ]
}
```

## Variables de Entorno

```env
# Habilitar auto-facturación al completar órdenes
SIIGO_AUTO_INVOICE_ON_COMPLETE=true

# Modo test (simula facturación sin llamar a Siigo)
SIIGO_TEST_MODE=true
```

## Errores Comunes

### "Orden partial-invoice inválida: La orden padre ya está facturada"

**Causa:** Intentas crear factura parcial de una orden que ya tiene `siigoId`.

**Solución:** Solo puedes facturar parcialmente remisiones (órdenes sin `siigoId`).

### "No hay suficiente inventario en remisión"

**Causa:** Solicitaste más cantidad de la que está disponible para facturar.

**Solución:** Consulta el balance con `/consignment-balance` antes de facturar.

### "Item ya está facturado"

**Causa:** Intentas facturar un item que ya fue facturado en otra orden parcial.

**Solución:** Verifica qué items están disponibles con `/invoiceable-items`.

## Endpoints Disponibles

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/orders/:orderId/invoiceable-items` | Lista items facturables de una orden |
| POST | `/api/orders/create-partial-invoice` | Crea orden de facturación parcial (búsqueda automática) |
| GET | `/api/customers/:customerId/consignment-balance` | Balance de remisión por cliente |
| GET | `/api/customers/:customerId/consignment-history` | Histórico de despachos y facturas |

## Integración con Siigo

Al completar una orden `partial-invoice` con `customerForInvoice`:

1. Se genera automáticamente la factura en Siigo (si auto-facturación está habilitada)
2. Se actualiza `siigoId` e `invoiceNumber` en la orden
3. La factura incluye solo los items de esta orden parcial, no de la orden padre

## Reportes y Análisis

### Balance Global de Remisiones

```sql
-- Total en remisión por cliente
SELECT
  c.name,
  SUM(CASE WHEN i.state = 'sold' THEN i.currentQuantity ELSE 0 END) as dispatched,
  SUM(CASE WHEN i.isInvoiced = true THEN i.currentQuantity ELSE 0 END) as invoiced,
  SUM(CASE WHEN i.state = 'sold' AND i.isInvoiced = false THEN i.currentQuantity ELSE 0 END) as pending
FROM items i
JOIN orders o ON i.sourceOrder = o.id
JOIN customers c ON o.customer = c.id
WHERE o.type = 'sale' AND o.state = 'completed'
GROUP BY c.id;
```

### Items Más Antiguos en Remisión

```sql
-- Items sin facturar ordenados por antigüedad
SELECT
  i.barcode,
  p.name as product,
  i.currentQuantity,
  o.actualDispatchDate,
  DATEDIFF(NOW(), o.actualDispatchDate) as days_in_consignment
FROM items i
JOIN orders o ON i.sourceOrder = o.id
JOIN products p ON i.product = p.id
WHERE i.state = 'sold' AND i.isInvoiced = false
ORDER BY o.actualDispatchDate ASC;
```

## Mejores Prácticas

1. **Consulta balance antes de facturar:** Siempre verifica qué está disponible
2. **Usa búsqueda automática:** Deja que el sistema aplique FIFO
3. **Documenta las notas:** Agrega comentarios en cada facturación parcial
4. **Monitorea inventario antiguo:** Alerta cuando items lleven mucho tiempo sin facturar
5. **Reconcilia periódicamente:** Compara tu balance con el del cliente

## Trazabilidad Completa

Cada operación mantiene trazabilidad:

```
Orden de Venta (SA-001)
  └─ Items despachados
       ├─ Item-001 (50 kg)
       │   └─ Facturado en PI-001 (30 kg) ✓
       │   └─ Pendiente: 20 kg
       │
       └─ Item-002 (50 kg)
           └─ Facturado en PI-002 (50 kg) ✓
```

Puedes rastrear:
- De qué orden padre vino cada item
- En qué órdenes parciales se facturó cada item
- Fechas de despacho y facturación
- Balance histórico por cliente y producto
