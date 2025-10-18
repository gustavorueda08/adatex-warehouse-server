# Casos de Uso del Sistema de Facturación Parcial

Este documento describe casos de uso reales del sistema de facturación parcial.

---

## Caso de Uso 1: Consignación Simple con Facturación Única

### Contexto
El cliente "Distribuidora ABC" recibe 100 kg de "Café Premium" en consignación (remisión). Después de una semana, reporta que vendió 60 kg y solicita la factura.

### Flujo

#### Paso 1: Despachar en Remisión
```
ACCIÓN: Crear orden de venta SIN facturar
ESTADO INICIAL: Inventario en bodega
ESTADO FINAL: Inventario en poder del cliente (sin facturar)
```

**Request:**
```json
POST /api/orders
{
  "data": {
    "type": "sale",
    "customer": 5,  // Distribuidora ABC
    "sourceWarehouse": 1,
    "notes": "Remisión - Consignación de Café Premium",
    "products": [{
      "product": 10,  // Café Premium
      "requestedQuantity": 100,
      "price": 25,
      "items": [{
        "barcode": "CAFE-LOTE123-0001",
        "warehouse": 1
      }]
    }]
  }
}
```

**Resultado:** Orden SALE-2025-001 creada en estado `draft`

#### Paso 2: Completar Despacho
```
ACCIÓN: Completar orden SIN customerForInvoice
ESTADO: Items cambian de "reserved" → "sold"
RESULTADO: Remisión activa
```

**Request:**
```json
PUT /api/orders/123
{
  "data": {
    "state": "completed",
    "actualDispatchDate": "2025-01-15"
  }
}
```

**Estado de los Items:**
```json
{
  "id": 456,
  "state": "sold",
  "isInvoiced": false,
  "currentQuantity": 100,
  "receiptDate": "2025-01-15T00:00:00.000Z"
}
```

#### Paso 3: Cliente Reporta Venta (1 semana después)
```
CLIENTE REPORTA: "Vendí 60 kg de los 100 kg"
ACCIÓN DEL VENDEDOR: Consultar balance y crear factura parcial
```

**Consultar Balance:**
```bash
GET /api/customers/5/consignment-balance
```

**Respuesta:**
```json
{
  "summary": {
    "totalDispatched": 100.0,
    "totalInvoiced": 0.0,
    "totalPending": 100.0
  }
}
```

#### Paso 4: Crear Factura Parcial
```
ACCIÓN: Facturar 60 kg usando FIFO automático
MÉTODO: POST /api/orders/create-partial-invoice
```

**Request:**
```json
POST /api/orders/create-partial-invoice
{
  "parentOrder": 123,
  "customer": 5,
  "customerForInvoice": 5,
  "products": [{
    "product": 10,
    "quantity": 60
  }],
  "notes": "Facturación - Primera venta reportada"
}
```

**Resultado:** Orden PI-2025-001 creada en estado `draft`

#### Paso 5: Completar Facturación
```
ACCIÓN: Completar factura parcial
RESULTADO:
- Items marcados como facturados (60 kg)
- Factura generada en Siigo
- Balance actualizado: 40 kg pendientes
```

**Request:**
```json
PUT /api/orders/125
{
  "data": {
    "state": "completed"
  }
}
```

**Estado de los Items (DESPUÉS):**
```json
{
  "id": 456,
  "state": "sold",
  "isInvoiced": true,
  "invoicedDate": "2025-01-22T10:00:00.000Z",
  "currentQuantity": 100
}
```

**Balance Actualizado:**
```json
{
  "summary": {
    "totalDispatched": 100.0,
    "totalInvoiced": 60.0,
    "totalPending": 40.0
  }
}
```

### Resultado Final
- ✅ 100 kg despachados en remisión
- ✅ 60 kg facturados (con Siigo ID)
- ✅ 40 kg aún en consignación
- ✅ Cliente puede reportar más ventas después

---

## Caso de Uso 2: Facturación Parcial Múltiple

### Contexto
El cliente "Supermercado XYZ" recibe 200 unidades de "Aceite de Oliva" en consignación. Factura en 3 momentos diferentes según va vendiendo.

### Flujo Detallado

#### Semana 1: Despacho Inicial
```
DESPACHO: 200 unidades
ESTADO: 200 disponibles para facturar
```

**Crear y Completar Orden:**
```bash
# Crear
POST /api/orders -> SALE-2025-010

# Completar sin facturar
PUT /api/orders/200 {"data": {"state": "completed"}}
```

**Balance:**
```
Despachado: 200 unidades
Facturado: 0 unidades
Pendiente: 200 unidades
```

#### Semana 2: Primera Facturación
```
CLIENTE REPORTA: "Vendí 50 unidades"
ACCIÓN: Facturar 50 unidades
```

**Crear Factura:**
```bash
POST /api/orders/create-partial-invoice
{
  "parentOrder": 200,
  "products": [{"product": 15, "quantity": 50}]
}
# -> PI-2025-020

PUT /api/orders/220 {"data": {"state": "completed"}}
```

**Balance Actualizado:**
```
Despachado: 200 unidades
Facturado: 50 unidades
Pendiente: 150 unidades
```

#### Semana 3: Segunda Facturación
```
CLIENTE REPORTA: "Vendí 80 unidades más"
ACCIÓN: Facturar 80 unidades
```

**Crear Factura:**
```bash
POST /api/orders/create-partial-invoice
{
  "parentOrder": 200,
  "products": [{"product": 15, "quantity": 80}]
}
# -> PI-2025-021

PUT /api/orders/221 {"data": {"state": "completed"}}
```

**Balance Actualizado:**
```
Despachado: 200 unidades
Facturado: 130 unidades (50 + 80)
Pendiente: 70 unidades
```

#### Semana 4: Tercera Facturación
```
CLIENTE REPORTA: "Vendí las 70 unidades restantes"
ACCIÓN: Facturar 70 unidades (cierra la remisión)
```

**Crear Factura:**
```bash
POST /api/orders/create-partial-invoice
{
  "parentOrder": 200,
  "products": [{"product": 15, "quantity": 70}]
}
# -> PI-2025-022

PUT /api/orders/222 {"data": {"state": "completed"}}
```

**Balance Final:**
```
Despachado: 200 unidades
Facturado: 200 unidades (50 + 80 + 70)
Pendiente: 0 unidades ✅ REMISIÓN CERRADA
```

### Historial Completo
```bash
GET /api/customers/7/consignment-history
```

**Respuesta:**
```json
[
  {
    "date": "2025-02-15T10:00:00.000Z",
    "type": "invoice",
    "orderCode": "PI-2025-022",
    "quantity": 70,
    "siigoId": "FV-789"
  },
  {
    "date": "2025-02-08T10:00:00.000Z",
    "type": "invoice",
    "orderCode": "PI-2025-021",
    "quantity": 80,
    "siigoId": "FV-456"
  },
  {
    "date": "2025-02-01T10:00:00.000Z",
    "type": "invoice",
    "orderCode": "PI-2025-020",
    "quantity": 50,
    "siigoId": "FV-123"
  },
  {
    "date": "2025-01-25T00:00:00.000Z",
    "type": "dispatch",
    "orderCode": "SALE-2025-010",
    "quantity": 200,
    "siigoId": null
  }
]
```

---

## Caso de Uso 3: Selección Manual de Items por Lote

### Contexto
El cliente "Tienda Premium" recibe café de 3 lotes diferentes en consignación:
- Lote A: 50 kg (recibido el 10/01)
- Lote B: 50 kg (recibido el 15/01)
- Lote C: 50 kg (recibido el 20/01)

El cliente vende primero el Lote C (más reciente) y quiere facturar ese lote específico, NO el más antiguo (LIFO en lugar de FIFO).

### Flujo

#### Paso 1: Despacho de 3 Lotes
```
ACCIÓN: Crear 3 órdenes de venta en diferentes fechas
```

**Orden 1 - Lote A (10/01):**
```bash
POST /api/orders -> SALE-2025-100
Items: [{ id: 501, lotNumber: "LOTE-A", quantity: 50 }]
```

**Orden 2 - Lote B (15/01):**
```bash
POST /api/orders -> SALE-2025-101
Items: [{ id: 502, lotNumber: "LOTE-B", quantity: 50 }]
```

**Orden 3 - Lote C (20/01):**
```bash
POST /api/orders -> SALE-2025-102
Items: [{ id: 503, lotNumber: "LOTE-C", quantity: 50 }]
```

**Todas completadas sin facturar**

#### Paso 2: Consultar Items Facturables
```
ACCIÓN: Ver todos los items disponibles con sus lotes
```

**Request:**
```bash
GET /api/orders/100/invoiceable-items
```

**Respuesta:**
```json
{
  "products": [{
    "product": {"id": 10, "name": "Café Premium"},
    "items": [
      {
        "id": 501,
        "lotNumber": "LOTE-A",
        "quantity": 50,
        "receiptDate": "2025-01-10"
      }
    ]
  }]
}

# Similar para órdenes 101 y 102
```

#### Paso 3: Cliente Vende Lote C Primero
```
CLIENTE REPORTA: "Vendí todo el Lote C (50 kg)"
VENDEDOR: Necesita facturar item 503 específicamente
MÉTODO: Selección manual (NO FIFO automático)
```

**Crear Factura Manual:**
```json
POST /api/orders
{
  "data": {
    "type": "partial-invoice",
    "parentOrder": 102,  // Orden del Lote C
    "customer": 8,
    "customerForInvoice": 8,
    "notes": "Facturación Lote C - Venta prioritaria",
    "products": [{
      "product": 10,
      "requestedQuantity": 50,
      "items": [
        { "id": 503 }  // Item específico del Lote C
      ]
    }]
  }
}
```

**Completar:**
```bash
PUT /api/orders/300 {"data": {"state": "completed"}}
```

#### Paso 4: Verificar Estado
```
RESULTADO:
- Lote A: 50 kg pendientes (más antiguo)
- Lote B: 50 kg pendientes
- Lote C: 50 kg facturados ✅
```

**Balance:**
```json
{
  "summary": {
    "totalDispatched": 150.0,
    "totalInvoiced": 50.0,
    "totalPending": 100.0
  },
  "products": [{
    "orders": [
      {
        "orderCode": "SALE-2025-100",
        "lotNumber": "LOTE-A",
        "pending": 50,
        "invoiced": 0
      },
      {
        "orderCode": "SALE-2025-101",
        "lotNumber": "LOTE-B",
        "pending": 50,
        "invoiced": 0
      },
      {
        "orderCode": "SALE-2025-102",
        "lotNumber": "LOTE-C",
        "pending": 0,
        "invoiced": 50
      }
    ]
  }]
}
```

### Ventaja
✅ Control preciso sobre QUÉ items se facturan
✅ Permite estrategias LIFO o selección por criterios específicos
✅ Útil para productos con vencimiento o lotes especiales

---

## Caso de Uso 4: Múltiples Productos en Una Factura

### Contexto
El cliente "Restaurante Gourmet" tiene en consignación:
- 50 kg de Aceite de Oliva
- 30 kg de Vinagre Balsámico
- 20 litros de Vino

Reporta ventas mixtas y quiere facturar todo junto.

### Flujo

#### Paso 1: Despachos Iniciales (3 órdenes)
```bash
# Orden 1: Aceite
POST /api/orders -> SALE-2025-200 (Aceite 50kg)

# Orden 2: Vinagre
POST /api/orders -> SALE-2025-201 (Vinagre 30kg)

# Orden 3: Vino
POST /api/orders -> SALE-2025-202 (Vino 20L)

# Completar todas sin facturar
```

#### Paso 2: Cliente Reporta Ventas Mixtas
```
CLIENTE REPORTA:
- Aceite: Vendí 30 kg de los 50 kg
- Vinagre: Vendí todo (30 kg)
- Vino: Vendí 15 litros de los 20 litros
```

#### Paso 3: Crear Factura Parcial Multi-Producto
```
ACCIÓN: Facturar los 3 productos en una sola factura
MÉTODO: FIFO automático para cada producto
```

**Request:**
```json
POST /api/orders/create-partial-invoice
{
  "parentOrder": 200,  // Orden principal (o cualquiera)
  "customer": 9,
  "customerForInvoice": 9,
  "products": [
    {
      "product": 10,  // Aceite
      "quantity": 30
    },
    {
      "product": 11,  // Vinagre
      "quantity": 30
    },
    {
      "product": 12,  // Vino
      "quantity": 15
    }
  ],
  "notes": "Facturación mixta - Semana 1"
}
```

**Resultado:**
```json
{
  "data": {
    "code": "PI-2025-050",
    "orderProducts": [
      {
        "product": {"id": 10, "name": "Aceite"},
        "fulfilledQuantity": 30
      },
      {
        "product": {"id": 11, "name": "Vinagre"},
        "fulfilledQuantity": 30
      },
      {
        "product": {"id": 12, "name": "Vino"},
        "fulfilledQuantity": 15
      }
    ],
    "subtotal": 2500.0,
    "totalAmount": 2975.0
  }
}
```

#### Paso 4: Completar y Verificar
```bash
PUT /api/orders/250 {"data": {"state": "completed"}}

GET /api/customers/9/consignment-balance
```

**Balance:**
```json
{
  "products": [
    {
      "product": {"name": "Aceite"},
      "totalDispatched": 50.0,
      "totalInvoiced": 30.0,
      "pendingBalance": 20.0
    },
    {
      "product": {"name": "Vinagre"},
      "totalDispatched": 30.0,
      "totalInvoiced": 30.0,
      "pendingBalance": 0.0  // ✅ Completamente facturado
    },
    {
      "product": {"name": "Vino"},
      "totalDispatched": 20.0,
      "totalInvoiced": 15.0,
      "pendingBalance": 5.0
    }
  ]
}
```

---

## Caso de Uso 5: Devolución y Re-Facturación

### Contexto
El cliente "Mayorista DEF" recibe 100 kg en consignación, factura 60 kg, pero devuelve 10 kg de lo facturado por daño.

### Flujo

#### Paso 1: Despacho y Primera Facturación
```bash
# Despacho
POST /api/orders -> SALE-2025-300 (100 kg)
PUT /api/orders/400 {"data": {"state": "completed"}}

# Facturación
POST /api/orders/create-partial-invoice
{ "parentOrder": 400, "products": [{"product": 10, "quantity": 60}] }
-> PI-2025-300
PUT /api/orders/500 {"data": {"state": "completed"}}
```

**Balance Después de Facturación:**
```
Despachado: 100 kg
Facturado: 60 kg
Pendiente: 40 kg
```

#### Paso 2: Cliente Devuelve 10 kg
```
CLIENTE: "Hay 10 kg con daño, los devuelvo"
ACCIÓN: Crear orden de devolución
```

**Orden de Devolución:**
```json
POST /api/orders
{
  "data": {
    "type": "return",
    "customer": 10,
    "destinationWarehouse": 1,
    "notes": "Devolución por daño - Producto defectuoso",
    "products": [{
      "product": 10,
      "requestedQuantity": 10,
      "items": [
        { "id": 456 }  // Item específico devuelto
      ]
    }]
  }
}
```

**Completar Devolución:**
```bash
PUT /api/orders/501 {"data": {"state": "completed"}}
```

#### Paso 3: Ajuste de Item
```
RESULTADO:
- Item 456 ahora tiene currentQuantity reducida
- O se crea nota de crédito en Siigo
```

**Escenario A - Reducir Cantidad:**
El item facturado se ajusta:
```json
{
  "id": 456,
  "originalQuantity": 100,
  "currentQuantity": 90,  // Reducido por devolución
  "isInvoiced": true,
  "state": "sold"
}
```

**Escenario B - Nota de Crédito:**
Se genera una nota de crédito en Siigo por 10 kg.

#### Paso 4: Balance Actualizado
```bash
GET /api/customers/10/consignment-balance
```

**Balance:**
```
Despachado: 90 kg (100 - 10 devueltos)
Facturado: 50 kg (60 - 10 devueltos)
Pendiente: 40 kg
```

---

## Caso de Uso 6: Consulta y Reportes

### Contexto
El gerente de ventas quiere saber el estado de todas las remisiones activas.

### Queries Útiles

#### 1. Ver Todos los Clientes con Remisión Activa
```bash
# Obtener todas las órdenes SALE completadas sin siigoId
GET /api/orders?filters[type][$eq]=sale&filters[state][$eq]=completed&filters[siigoId][$null]=true
```

#### 2. Balance por Cliente Específico
```bash
GET /api/customers/5/consignment-balance
```

#### 3. Historial Completo de un Cliente
```bash
GET /api/customers/5/consignment-history?startDate=2025-01-01&endDate=2025-01-31
```

#### 4. Facturas Parciales Pendientes de Completar
```bash
GET /api/orders?filters[type][$eq]=partial-invoice&filters[state][$eq]=draft
```

#### 5. Facturas Parciales Sin Número de Siigo
```bash
GET /api/orders?filters[type][$eq]=partial-invoice&filters[state][$eq]=completed&filters[siigoId][$null]=true
```

#### 6. Items Específicos de una Orden
```bash
GET /api/orders/123/invoiceable-items
```

---

## Diagrama de Estados

```
┌─────────────┐
│   ORDEN     │
│    SALE     │
│   (draft)   │
└──────┬──────┘
       │ PUT state: "completed"
       │ (SIN customerForInvoice)
       ▼
┌─────────────┐
│   ORDEN     │
│    SALE     │  ← REMISIÓN ACTIVA
│ (completed) │    (siigoId: null)
│siigoId:null │
└──────┬──────┘
       │
       │ ┌─────────────────────────────┐
       │ │  Crear Factura Parcial      │
       │ │  POST /create-partial-      │
       │ │  invoice                     │
       │ └─────────────────────────────┘
       │
       ▼
┌─────────────┐
│   ORDEN     │
│  PARTIAL-   │
│  INVOICE    │
│   (draft)   │
└──────┬──────┘
       │ PUT state: "completed"
       ▼
┌─────────────┐
│   ORDEN     │
│  PARTIAL-   │  ← FACTURADA
│  INVOICE    │    (con siigoId)
│ (completed) │
│siigoId: FV-X│
└─────────────┘
       │
       │ Items: isInvoiced = true
       │
       ▼
┌─────────────┐
│   BALANCE   │
│ ACTUALIZADO │  ← Pendiente reducido
└─────────────┘
```

---

## Mejores Prácticas

### 1. Naming Conventions
```
Remisiones:        SALE-YYYY-XXX
Facturas Parciales: PI-YYYY-XXX
```

### 2. Notas Descriptivas
```
Siempre agregar notas claras:
- "Remisión - Consignación inicial"
- "Facturación parcial - Primera venta"
- "Facturación Lote C - Venta prioritaria"
```

### 3. Validar Antes de Facturar
```bash
# Siempre consultar balance primero
GET /api/customers/:id/consignment-balance

# Verificar items disponibles
GET /api/orders/:id/invoiceable-items
```

### 4. Monitorear Remisiones Antiguas
```bash
# Buscar remisiones con más de 30 días
GET /api/orders?filters[type][$eq]=sale&filters[state][$eq]=completed&filters[siigoId][$null]=true&filters[actualDispatchDate][$lt]=2024-12-15
```

### 5. Auditoría
```bash
# Historial completo para auditoría
GET /api/customers/:id/consignment-history?limit=1000
```

---

## Solución de Problemas Comunes

### Problema 1: "No hay suficiente inventario"
**Error:** `No hay suficiente inventario en remisión. Solicitado: 200, Disponible: 100`

**Solución:**
```bash
# Ver balance real
GET /api/customers/:id/consignment-balance?product=:productId

# Ajustar cantidad solicitada
POST /api/orders/create-partial-invoice
{
  "products": [{"product": 10, "quantity": 100}]  // Reducir a disponible
}
```

### Problema 2: "Item ya está facturado"
**Error:** `Item 456 ya está facturado`

**Solución:**
```bash
# Consultar items facturables
GET /api/orders/:id/invoiceable-items

# Usar solo items con isInvoiced: false
```

### Problema 3: "Orden padre ya está facturada"
**Error:** `La orden padre ya está facturada (tiene siigoId)`

**Causa:** La orden SALE tiene `siigoId` (fue facturada completamente)

**Solución:**
- No se puede crear factura parcial de una orden ya facturada
- Solo se puede facturar parcialmente de REMISIONES (sin siigoId)

---

## Conclusión

El sistema soporta:
✅ Remisiones (despachos sin facturar)
✅ Facturación parcial en múltiples momentos
✅ Selección automática (FIFO) o manual
✅ Múltiples productos por factura
✅ Balance en tiempo real
✅ Historial completo
✅ Integración con Siigo

Para más detalles técnicos, consulta:
- `API_ENDPOINTS_PARTIAL_INVOICE.md` - Documentación de endpoints
- `EJEMPLOS_API_REQUESTS.md` - Ejemplos de requests
- `RESUMEN_ADAPTACION_BACKEND.md` - Resumen técnico
