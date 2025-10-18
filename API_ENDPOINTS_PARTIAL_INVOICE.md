# API Endpoints - Sistema de Facturación Parcial

Documentación de los endpoints del backend para el sistema de facturación parcial e inventario en remisión.

## Base URL
```
http://localhost:1337/api
```

---

## 1. Balance de Remisión

### Obtener Balance del Cliente

**Endpoint:** `GET /customers/:customerId/consignment-balance`

**Descripción:** Obtiene el balance de inventario despachado pero no facturado para un cliente específico.

**Parámetros de URL:**
- `customerId` (requerido): ID del cliente

**Query Parameters:**
- `product` (opcional): ID del producto para filtrar el balance de un producto específico

**Ejemplo de Request:**
```http
GET /api/customers/5/consignment-balance
```

**Ejemplo de Request con filtro:**
```http
GET /api/customers/5/consignment-balance?product=10
```

**Respuesta Exitosa (200):**
```json
{
  "data": {
    "customer": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "products": [
      {
        "product": {
          "id": 10,
          "name": "Producto A",
          "code": "PROD-A",
          "unit": "kg"
        },
        "totalDispatched": 100.0,
        "totalInvoiced": 60.0,
        "pendingBalance": 40.0,
        "orders": [
          {
            "orderId": 123,
            "orderCode": "SALE-2025-001",
            "dispatchDate": "2025-01-15T00:00:00.000Z",
            "invoiced": false,
            "siigoId": null,
            "dispatched": 100.0,
            "invoicedQty": 60.0,
            "pending": 40.0
          }
        ]
      }
    ],
    "summary": {
      "totalDispatched": 100.0,
      "totalInvoiced": 60.0,
      "totalPending": 40.0
    }
  },
  "meta": {}
}
```

**Errores:**
- `500`: Error interno del servidor

---

## 2. Historial de Remisión

### Obtener Historial del Cliente

**Endpoint:** `GET /customers/:customerId/consignment-history`

**Descripción:** Obtiene el historial de despachos y facturaciones parciales para un cliente.

**Parámetros de URL:**
- `customerId` (requerido): ID del cliente

**Query Parameters:**
- `startDate` (opcional): Fecha de inicio (formato ISO 8601)
- `endDate` (opcional): Fecha de fin (formato ISO 8601)
- `product` (opcional): ID del producto para filtrar
- `limit` (opcional): Límite de registros (default: 50)

**Ejemplo de Request:**
```http
GET /api/customers/5/consignment-history?startDate=2025-01-01&endDate=2025-01-31&limit=100
```

**Respuesta Exitosa (200):**
```json
{
  "data": [
    {
      "date": "2025-01-15T00:00:00.000Z",
      "type": "dispatch",
      "orderId": 123,
      "orderCode": "SALE-2025-001",
      "product": {
        "id": 10,
        "name": "Producto A",
        "code": "PROD-A"
      },
      "quantity": 100.0,
      "invoiced": false,
      "siigoId": null,
      "parentOrderId": null,
      "parentOrderCode": null
    },
    {
      "date": "2025-01-20T00:00:00.000Z",
      "type": "invoice",
      "orderId": 125,
      "orderCode": "PI-2025-001",
      "product": {
        "id": 10,
        "name": "Producto A",
        "code": "PROD-A"
      },
      "quantity": 60.0,
      "invoiced": true,
      "siigoId": "FV-12345",
      "parentOrderId": 123,
      "parentOrderCode": "SALE-2025-001"
    }
  ],
  "meta": {
    "count": 2
  }
}
```

**Errores:**
- `500`: Error interno del servidor

---

## 3. Items Facturables de una Orden

### Obtener Items Facturables

**Endpoint:** `GET /orders/:orderId/invoiceable-items`

**Descripción:** Obtiene los items de una orden de venta completada que están disponibles para facturación (despachados pero no facturados).

**Parámetros de URL:**
- `orderId` (requerido): ID de la orden de venta

**Ejemplo de Request:**
```http
GET /api/orders/123/invoiceable-items
```

**Respuesta Exitosa (200):**
```json
{
  "data": {
    "order": {
      "id": 123,
      "code": "SALE-2025-001",
      "dispatchDate": "2025-01-15T00:00:00.000Z",
      "customer": {
        "id": 5,
        "name": "Cliente ABC"
      }
    },
    "products": [
      {
        "product": {
          "id": 10,
          "name": "Producto A",
          "code": "PROD-A",
          "unit": "kg"
        },
        "totalQuantity": 100.0,
        "itemCount": 2,
        "items": [
          {
            "id": 456,
            "barcode": "ITEM-001",
            "quantity": 50.0,
            "lotNumber": "LOTE-001",
            "state": "sold"
          },
          {
            "id": 457,
            "barcode": "ITEM-002",
            "quantity": 50.0,
            "lotNumber": "LOTE-001",
            "state": "sold"
          }
        ]
      }
    ],
    "summary": {
      "totalProducts": 1,
      "totalItems": 2
    }
  },
  "meta": {}
}
```

**Errores:**
- `404`: Orden no encontrada
- `400`: La orden no es de tipo 'sale', no está completada, o ya está facturada
- `500`: Error interno del servidor

---

## 4. Crear Factura Parcial

### 4.1. Creación Automática con FIFO

**Endpoint:** `POST /orders/create-partial-invoice`

**Descripción:** Crea una factura parcial usando selección automática FIFO (First In, First Out). El sistema selecciona automáticamente los items más antiguos disponibles.

**Request Body:**
```json
{
  "parentOrder": 123,
  "customer": 5,
  "customerForInvoice": 5,
  "products": [
    {
      "product": 10,
      "quantity": 60
    }
  ],
  "notes": "Facturación parcial - Primera venta" // Opcional
}
```

**Respuesta Exitosa (200):**
```json
{
  "data": {
    "id": 125,
    "code": "PI-2025-001",
    "type": "partial-invoice",
    "state": "draft",
    "parentOrder": {
      "id": 123,
      "code": "SALE-2025-001"
    },
    "customer": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "customerForInvoice": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "items": [
      // Items seleccionados automáticamente
    ],
    "orderProducts": [
      // Productos de la factura
    ],
    "subtotal": 1200.0,
    "taxAmount": 228.0,
    "totalAmount": 1428.0,
    "notes": "Facturación parcial - Primera venta",
    "createdDate": "2025-01-20T10:00:00.000Z"
  },
  "meta": {
    "message": "Orden de facturación parcial creada exitosamente",
    "type": "fifo-automatic"
  }
}
```

**Validaciones:**
- `parentOrder` es requerido
- `products` debe ser un array con al menos un producto
- Cada producto debe tener `product` (ID) y `quantity` > 0
- Debe haber suficiente inventario disponible en remisión

**Errores:**
- `400`: Datos inválidos o falta de inventario
- `404`: Orden padre no encontrada
- `500`: Error interno del servidor

---

### 4.2. Creación Manual con Selección de Items

**Endpoint:** `POST /orders`

**Descripción:** Crea una factura parcial especificando manualmente los items a facturar. Útil cuando se necesita control preciso sobre qué items facturar.

**Request Body:**
```json
{
  "data": {
    "type": "partial-invoice",
    "parentOrder": 123,
    "customer": 5,
    "customerForInvoice": 5,
    "notes": "Facturación parcial manual",
    "products": [
      {
        "product": 10,
        "requestedQuantity": 60,
        "items": [
          { "id": 456 },
          { "id": 457 }
        ]
      }
    ]
  }
}
```

**Respuesta Exitosa (200):**
```json
{
  "data": {
    "id": 125,
    "code": "PI-2025-001",
    "type": "partial-invoice",
    "state": "draft",
    "parentOrder": {
      "id": 123,
      "code": "SALE-2025-001"
    },
    "customer": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "customerForInvoice": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "items": [
      {
        "id": 456,
        "barcode": "ITEM-001",
        "currentQuantity": 30.0,
        "state": "sold",
        "isInvoiced": false
      },
      {
        "id": 457,
        "barcode": "ITEM-002",
        "currentQuantity": 30.0,
        "state": "sold",
        "isInvoiced": false
      }
    ],
    "orderProducts": [
      // Productos de la factura
    ],
    "subtotal": 1200.0,
    "taxAmount": 228.0,
    "totalAmount": 1428.0,
    "notes": "Facturación parcial manual",
    "createdDate": "2025-01-20T10:00:00.000Z"
  },
  "meta": {}
}
```

**Validaciones:**
- La orden padre debe existir y ser de tipo 'sale'
- La orden padre debe estar completada
- La orden padre NO debe tener `siigoId` (debe ser remisión)
- Los items especificados deben:
  - Pertenecer a la orden padre
  - Estar en estado 'sold'
  - NO estar ya facturados (`isInvoiced: false`)

**Errores:**
- `400`: Datos inválidos, items ya facturados, o items no pertenecen a la orden padre
- `404`: Orden padre o items no encontrados
- `500`: Error interno del servidor

---

## 5. Completar y Facturar

### Completar Factura Parcial

**Endpoint:** `PUT /orders/:orderId`

**Descripción:** Completa una factura parcial y genera la factura en Siigo (si está configurado). Al completar, marca los items como facturados.

**Parámetros de URL:**
- `orderId` (requerido): ID de la factura parcial

**Request Body:**
```json
{
  "data": {
    "state": "completed"
  }
}
```

**Respuesta Exitosa (200):**
```json
{
  "data": {
    "id": 125,
    "code": "PI-2025-001",
    "type": "partial-invoice",
    "state": "completed",
    "siigoId": "FV-12345",
    "invoiceNumber": "FV-12345",
    "parentOrder": {
      "id": 123,
      "code": "SALE-2025-001"
    },
    "customer": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "customerForInvoice": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "items": [
      {
        "id": 456,
        "barcode": "ITEM-001",
        "currentQuantity": 30.0,
        "state": "sold",
        "isInvoiced": true,
        "invoicedDate": "2025-01-20T10:30:00.000Z"
      },
      {
        "id": 457,
        "barcode": "ITEM-002",
        "currentQuantity": 30.0,
        "state": "sold",
        "isInvoiced": true,
        "invoicedDate": "2025-01-20T10:30:00.000Z"
      }
    ],
    "orderProducts": [
      // Productos de la factura
    ],
    "subtotal": 1200.0,
    "taxAmount": 228.0,
    "totalAmount": 1428.0,
    "completedDate": "2025-01-20T10:30:00.000Z"
  },
  "meta": {}
}
```

**Comportamiento:**
1. Cambia el estado de la orden a `completed`
2. Marca todos los items asociados como `isInvoiced: true`
3. Registra `invoicedDate` en los items
4. Si `SIIGO_AUTO_INVOICE_ON_COMPLETE=true`, genera factura en Siigo automáticamente
5. Actualiza `siigoId` y `invoiceNumber` si la factura se crea exitosamente

**Errores:**
- `400`: La orden no puede ser completada (estado inválido)
- `404`: Orden no encontrada
- `500`: Error interno del servidor o error en Siigo

---

## 6. Obtener Factura Parcial

### Obtener Detalles de Factura Parcial

**Endpoint:** `GET /orders/:id`

**Descripción:** Obtiene los detalles completos de una factura parcial.

**Parámetros de URL:**
- `id` (requerido): ID de la factura parcial

**Query Parameters:**
- `populate` (opcional): Campos a poblar (default: todos los necesarios)

**Ejemplo de Request:**
```http
GET /api/orders/125
```

**Respuesta:** Similar a la respuesta de creación, con todos los datos poblados.

---

## 7. Listar Facturas Parciales

### Listar Todas las Facturas Parciales

**Endpoint:** `GET /orders?filters[type][$eq]=partial-invoice`

**Descripción:** Lista todas las facturas parciales con filtros opcionales.

**Query Parameters:**
- `filters[type][$eq]=partial-invoice` (requerido): Filtrar por tipo
- `filters[state][$eq]=completed` (opcional): Filtrar por estado
- `filters[customer][id][$eq]=5` (opcional): Filtrar por cliente
- `filters[siigoId][$null]=true` (opcional): Filtrar pendientes de facturación
- `sort[0]=createdDate:desc` (opcional): Ordenar por fecha
- `pagination[page]=1` (opcional): Página
- `pagination[pageSize]=25` (opcional): Tamaño de página

**Ejemplo de Request:**
```http
GET /api/orders?filters[type][$eq]=partial-invoice&filters[state][$eq]=completed&sort[0]=createdDate:desc
```

**Respuesta Exitosa (200):**
```json
{
  "data": [
    {
      "id": 125,
      "code": "PI-2025-001",
      "type": "partial-invoice",
      "state": "completed",
      "siigoId": "FV-12345",
      "invoiceNumber": "FV-12345",
      "parentOrder": {
        "id": 123,
        "code": "SALE-2025-001"
      },
      "customer": {
        "id": 5,
        "name": "Cliente ABC"
      },
      "totalAmount": 1428.0,
      "createdDate": "2025-01-20T10:00:00.000Z",
      "completedDate": "2025-01-20T10:30:00.000Z"
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "pageSize": 25,
      "pageCount": 1,
      "total": 1
    }
  }
}
```

---

## Notas Importantes

### Estados de Orden
- `draft`: Factura parcial creada pero no completada
- `confirmed`: (No usado típicamente para partial-invoice)
- `completed`: Factura parcial completada y items marcados como facturados

### Estados de Item
- `available`: Disponible en inventario
- `reserved`: Reservado en una orden de venta
- `sold`: Despachado al cliente
- `dropped`: Dado de baja

### Campos de Facturación de Item
- `isInvoiced`: Boolean que indica si el item ya fue facturado
- `invoicedDate`: Fecha en que se facturó el item

### Relaciones
- Una orden de venta puede tener múltiples facturas parciales (hijas)
- Una factura parcial tiene una orden de venta como padre (`parentOrder`)
- Los items se relacionan con órdenes mediante relación many-to-many

### Variables de Entorno
- `SIIGO_AUTO_INVOICE_ON_COMPLETE`: Si es `"true"`, auto-factura al completar
- `SIIGO_TEST_MODE`: Si es `"true"`, simula la facturación sin llamar a Siigo

---

## Ejemplos de Flujos Completos

### Flujo 1: Facturación Parcial Automática (FIFO)

```bash
# 1. Crear orden de venta (remisión)
POST /api/orders
{
  "data": {
    "type": "sale",
    "customer": 5,
    "sourceWarehouse": 1,
    "products": [...]
  }
}

# 2. Completar orden (despachar sin facturar)
PUT /api/orders/123
{
  "data": {
    "state": "completed"
  }
}

# 3. Consultar balance
GET /api/customers/5/consignment-balance

# 4. Crear factura parcial (FIFO automático)
POST /api/orders/create-partial-invoice
{
  "parentOrder": 123,
  "customer": 5,
  "customerForInvoice": 5,
  "products": [
    { "product": 10, "quantity": 60 }
  ]
}

# 5. Completar factura parcial
PUT /api/orders/125
{
  "data": {
    "state": "completed"
  }
}

# 6. Verificar balance actualizado
GET /api/customers/5/consignment-balance
```

### Flujo 2: Facturación Parcial Manual

```bash
# 1-2. Igual que flujo 1

# 3. Obtener items facturables
GET /api/orders/123/invoiceable-items

# 4. Crear factura parcial con items específicos
POST /api/orders
{
  "data": {
    "type": "partial-invoice",
    "parentOrder": 123,
    "customer": 5,
    "customerForInvoice": 5,
    "products": [
      {
        "product": 10,
        "requestedQuantity": 60,
        "items": [
          { "id": 456 },
          { "id": 457 }
        ]
      }
    ]
  }
}

# 5-6. Igual que flujo 1
```

---

## Soporte

Para más información, consulta:
- Guía de facturación parcial: `PARTIAL_INVOICE_GUIDE.md`
- Código fuente de controladores: `src/api/order/controllers/order.js`
- Código fuente de servicios: `src/api/customer/services/customer.js`
