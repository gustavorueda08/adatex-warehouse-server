# Sistema de Facturación Parcial - Backend

## ✅ Estado: COMPLETAMENTE IMPLEMENTADO Y LISTO

Tu backend ya tiene **TODA** la funcionalidad necesaria para soportar el sistema de facturación parcial del frontend. No se requieren cambios mayores.

---

## 📚 Documentación Disponible

### 1. [RESUMEN_ADAPTACION_BACKEND.md](RESUMEN_ADAPTACION_BACKEND.md)
**📋 Resumen ejecutivo y técnico**
- Estado actual del sistema
- Funcionalidades validadas
- Cambios mínimos realizados
- Estructura de datos clave
- Archivos importantes del backend

**👉 Empieza aquí** para entender qué hay implementado.

---

### 2. [API_ENDPOINTS_PARTIAL_INVOICE.md](API_ENDPOINTS_PARTIAL_INVOICE.md)
**📡 Documentación completa de endpoints**
- Todos los endpoints disponibles
- Request/Response schemas
- Query parameters
- Validaciones
- Casos de error
- Ejemplos de uso

**👉 Referencia completa** para integrar el frontend.

---

### 3. [EJEMPLOS_API_REQUESTS.md](EJEMPLOS_API_REQUESTS.md)
**🧪 Ejemplos de requests y responses reales**
- Ejemplos con `curl`
- Colección de Postman
- Script bash completo de testing
- Casos de error
- Respuestas esperadas

**👉 Usa esto** para probar la API.

---

### 4. [CASOS_DE_USO.md](CASOS_DE_USO.md)
**💼 Casos de uso reales del negocio**
- Consignación simple
- Facturación múltiple
- Selección manual por lote
- Múltiples productos
- Devoluciones
- Reportes
- Diagrama de estados

**👉 Entiende** los flujos de negocio completos.

---

### 5. [PARTIAL_INVOICE_GUIDE.md](PARTIAL_INVOICE_GUIDE.md)
**📖 Guía original del backend**
- Conceptos técnicos
- Flujo de datos
- Estrategias de movimiento
- Integración con Siigo

**👉 Detalles técnicos** de la implementación.

---

## 🚀 Quick Start para el Frontend

### Paso 1: Endpoints Principales

```javascript
// 1. Balance de remisión
GET /api/customers/:customerId/consignment-balance

// 2. Historial
GET /api/customers/:customerId/consignment-history

// 3. Items facturables de una orden
GET /api/orders/:orderId/invoiceable-items

// 4. Crear factura parcial (FIFO automático)
POST /api/orders/create-partial-invoice
{
  "parentOrder": 123,
  "customer": 5,
  "customerForInvoice": 5,
  "products": [{ "product": 10, "quantity": 60 }]
}

// 5. Crear factura parcial (selección manual)
POST /api/orders
{
  "data": {
    "type": "partial-invoice",
    "parentOrder": 123,
    "products": [{
      "product": 10,
      "items": [{ "id": 456 }, { "id": 457 }]
    }]
  }
}

// 6. Completar factura parcial
PUT /api/orders/:orderId
{
  "data": { "state": "completed" }
}
```

### Paso 2: Ejemplo Completo

```bash
# 1. Crear remisión
curl -X POST http://localhost:1337/api/orders \
  -d '{"data": {"type": "sale", "customer": 5, ...}}'

# 2. Completar sin facturar
curl -X PUT http://localhost:1337/api/orders/123 \
  -d '{"data": {"state": "completed"}}'

# 3. Ver balance
curl http://localhost:1337/api/customers/5/consignment-balance

# 4. Crear factura parcial
curl -X POST http://localhost:1337/api/orders/create-partial-invoice \
  -d '{"parentOrder": 123, "products": [{"product": 10, "quantity": 60}]}'

# 5. Completar factura
curl -X PUT http://localhost:1337/api/orders/125 \
  -d '{"data": {"state": "completed"}}'

# 6. Verificar balance actualizado
curl http://localhost:1337/api/customers/5/consignment-balance
```

---

## 📦 Estructura de Datos

### Remisión (Order type: "sale" sin siigoId)
```json
{
  "id": 123,
  "type": "sale",
  "state": "completed",
  "siigoId": null,  // ← Sin facturar = REMISIÓN
  "items": [
    {
      "id": 456,
      "state": "sold",
      "isInvoiced": false,  // ← Disponible para facturar
      "currentQuantity": 100
    }
  ]
}
```

### Factura Parcial (Order type: "partial-invoice")
```json
{
  "id": 125,
  "type": "partial-invoice",
  "state": "completed",
  "parentOrder": { "id": 123 },
  "siigoId": "FV-12345",  // ← Facturada en Siigo
  "items": [
    {
      "id": 456,
      "state": "sold",
      "isInvoiced": true,  // ← Ya facturado
      "invoicedDate": "2025-01-20T10:30:00.000Z"
    }
  ]
}
```

### Balance de Remisión
```json
{
  "customer": { "id": 5, "name": "Cliente ABC" },
  "products": [{
    "product": { "id": 10, "name": "Producto A" },
    "totalDispatched": 100.0,
    "totalInvoiced": 60.0,
    "pendingBalance": 40.0,
    "orders": [...]
  }],
  "summary": {
    "totalDispatched": 100.0,
    "totalInvoiced": 60.0,
    "totalPending": 40.0
  }
}
```

---

## 🔑 Conceptos Clave

### Remisión
- Orden de venta (`type: "sale"`) **completada** pero **SIN** `siigoId`
- Items en estado `"sold"` con `isInvoiced: false`
- Inventario en poder del cliente pero no facturado

### Facturación Parcial
- Orden de tipo `"partial-invoice"` vinculada a orden padre
- NO mueve inventario físico
- Solo asocia items existentes para facturación
- Genera `siigoId` al completarse
- Marca items como `isInvoiced: true`

### FIFO (First In, First Out)
- Método automático de selección de items
- Selecciona items más antiguos primero
- Basado en `actualDispatchDate` de la orden padre

### Selección Manual
- Especifica items por ID
- Útil para lotes específicos o estrategias LIFO
- Control preciso sobre qué items facturar

---

## 🏗️ Arquitectura del Backend

### Modelos
```
Order (api::order.order)
├── type: "sale" | "partial-invoice" | ...
├── state: "draft" | "completed" | ...
├── siigoId: string | null
├── parentOrder: Order (relación)
└── items: [Item] (many-to-many)

Item (api::item.item)
├── state: "available" | "sold" | ...
├── isInvoiced: boolean
├── invoicedDate: datetime
└── orders: [Order] (many-to-many)
```

### Servicios Clave
```
src/api/order/services/order.js
├── create() - Crea órdenes con estrategias
├── update() - Actualiza órdenes
└── doItemMovement() - Mueve items

src/api/customer/services/customer.js
├── getConsignmentBalance() - Balance de remisión
└── getConsignmentHistory() - Historial

src/api/order/utils/invoiceHelpers.js
├── findInvoiceableItemsByQuantity() - FIFO
├── validatePartialInvoiceOrder() - Validaciones
├── getInvoiceableItemsFromOrder() - Items facturables
├── markItemsAsInvoiced() - Marcar facturados
└── unmarkItemsAsInvoiced() - Revertir
```

### Estrategias
```
src/api/order/strategies/itemMovementStrategies.js
└── PartialInvoiceStrategy
    ├── create() - Asocia items (FIFO o manual)
    ├── update() - Marca como facturado al completar
    └── delete() - Revierte facturación
```

---

## ⚙️ Variables de Entorno

```env
# Auto-facturación en Siigo al completar orden
SIIGO_AUTO_INVOICE_ON_COMPLETE=true

# Modo test (simula Siigo sin llamar API)
SIIGO_TEST_MODE=true

# URL de Siigo
SIIGO_API_URL=https://api.siigo.com
```

---

## ✅ Cambios Realizados

### Mínimos y No Críticos

1. **Validaciones Mejoradas** en `src/api/order/controllers/order.js:235-299`
   - Validación de estructura de productos
   - Validación de cantidad > 0
   - Mensajes de error más descriptivos

2. **Documentación Completa**
   - `API_ENDPOINTS_PARTIAL_INVOICE.md`
   - `EJEMPLOS_API_REQUESTS.md`
   - `CASOS_DE_USO.md`
   - `RESUMEN_ADAPTACION_BACKEND.md`
   - `README_FACTURACION_PARCIAL.md` (este archivo)

**Nota:** NO se modificaron modelos, servicios, estrategias ni lógica de negocio.

---

## 🧪 Testing

### Script de Testing Completo
```bash
#!/bin/bash

API_BASE="http://localhost:1337/api"
TOKEN="your-auth-token"

# 1. Crear remisión
ORDER_ID=$(curl -s -X POST "${API_BASE}/orders" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"data": {"type": "sale", "customer": 5, ...}}' \
  | jq -r '.data.id')

# 2. Completar sin facturar
curl -X PUT "${API_BASE}/orders/${ORDER_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"data": {"state": "completed"}}'

# 3. Ver balance
curl "${API_BASE}/customers/5/consignment-balance" \
  -H "Authorization: Bearer ${TOKEN}"

# 4. Crear factura parcial
INVOICE_ID=$(curl -s -X POST "${API_BASE}/orders/create-partial-invoice" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{\"parentOrder\": ${ORDER_ID}, \"products\": [{\"product\": 10, \"quantity\": 60}]}" \
  | jq -r '.data.id')

# 5. Completar factura
curl -X PUT "${API_BASE}/orders/${INVOICE_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"data": {"state": "completed"}}'

# 6. Verificar balance
curl "${API_BASE}/customers/5/consignment-balance" \
  -H "Authorization: Bearer ${TOKEN}"
```

Ver más ejemplos en [EJEMPLOS_API_REQUESTS.md](EJEMPLOS_API_REQUESTS.md).

---

## 📊 Flujo de Estados

```
┌─────────────┐
│ SALE draft  │
└──────┬──────┘
       │ Completar SIN customerForInvoice
       ▼
┌──────────────┐
│SALE completed│  ← REMISIÓN
│ siigoId:null │
└──────┬───────┘
       │ Crear factura parcial
       ▼
┌────────────────┐
│ PI draft       │
│ parentOrder:123│
└──────┬─────────┘
       │ Completar
       ▼
┌────────────────┐
│ PI completed   │  ← FACTURADA
│ siigoId:FV-123 │
└────────────────┘
```

---

## 🎯 Para el Frontend

### Hooks Sugeridos
```javascript
// Balance de remisión
const { data, isLoading } = useConsignmentBalance(customerId);

// Historial
const { history } = useConsignmentHistory(customerId, { startDate, endDate });

// Items facturables
const { items } = useInvoiceableItems(orderId);

// Crear factura
const createPartialInvoice = useCreatePartialInvoice();
await createPartialInvoice.mutate({ parentOrder, products });
```

### Componentes Sugeridos
- `ConsignmentBalance.jsx` - Balance del cliente
- `InvoiceableItemsTable.jsx` - Items disponibles
- `PartialInvoiceForm.jsx` - Formulario de facturación
- `ConsignmentHistoryTable.jsx` - Historial

---

## 🔗 Enlaces Útiles

- **Strapi Docs:** https://docs.strapi.io
- **Guía Frontend:** Ver documento original del usuario
- **Repositorio:** /Users/grmini/Develop - Local/adatex-warehouse-server

---

## 💡 Tips y Mejores Prácticas

1. **Siempre consulta balance antes de facturar**
   ```bash
   GET /api/customers/:id/consignment-balance
   ```

2. **Valida items disponibles**
   ```bash
   GET /api/orders/:id/invoiceable-items
   ```

3. **Usa notas descriptivas**
   ```json
   { "notes": "Facturación parcial - Primera venta" }
   ```

4. **Monitorea remisiones antiguas**
   ```bash
   # Remisiones con > 30 días
   GET /api/orders?filters[type][$eq]=sale&...
   ```

5. **Audita con historial**
   ```bash
   GET /api/customers/:id/consignment-history?limit=1000
   ```

---

## 🐛 Troubleshooting

### "No hay suficiente inventario"
**Solución:** Verifica balance real
```bash
GET /api/customers/:id/consignment-balance?product=:productId
```

### "Item ya está facturado"
**Solución:** Consulta items facturables
```bash
GET /api/orders/:id/invoiceable-items
```

### "Orden padre ya facturada"
**Causa:** La orden tiene `siigoId`
**Solución:** Solo puedes facturar de remisiones (sin `siigoId`)

---

## 📞 Soporte

Para más información:
- 📖 Ver documentación completa en los archivos mencionados
- 💻 Revisar código fuente en `src/api/`
- 📝 Consultar guía original del frontend

---

## ✨ Resumen Final

### ✅ Qué Está Listo
- ✅ Todos los endpoints implementados
- ✅ Modelo de datos completo
- ✅ Validaciones de negocio
- ✅ Estrategias de movimiento
- ✅ Integración con Siigo
- ✅ FIFO automático y selección manual
- ✅ Balance en tiempo real
- ✅ Historial completo
- ✅ Documentación completa

### 🎯 Qué Hacer Ahora
1. ✅ **Backend:** Listo para usar
2. 🔨 **Frontend:** Implementar hooks y componentes
3. 🧪 **Testing:** Usar scripts de ejemplo
4. 🚀 **Deploy:** Configurar variables de entorno

---

**¡El backend está 100% funcional y listo para el frontend!** 🎉
