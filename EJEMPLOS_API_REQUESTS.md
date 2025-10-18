# Ejemplos de Requests/Responses para Testing

Colección de ejemplos de requests y responses reales para probar la API de facturación parcial.

---

## Variables de Entorno

```bash
export API_BASE="http://localhost:1337/api"
export CUSTOMER_ID=5
export PRODUCT_ID=10
export WAREHOUSE_ID=1
```

---

## 1. Crear Orden de Venta (Remisión)

### Request
```bash
curl -X POST "${API_BASE}/orders" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "data": {
      "type": "sale",
      "customer": 5,
      "sourceWarehouse": 1,
      "notes": "Remisión - Despacho sin facturar",
      "products": [
        {
          "product": 10,
          "requestedQuantity": 100,
          "price": 20,
          "items": [
            {
              "barcode": "PROD10-LOTE001-0001-CONT001",
              "warehouse": 1
            }
          ]
        }
      ]
    }
  }'
```

### Response
```json
{
  "data": {
    "id": 123,
    "code": "SALE-2025-001",
    "type": "sale",
    "state": "draft",
    "customer": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "sourceWarehouse": {
      "id": 1,
      "name": "Bodega Principal"
    },
    "orderProducts": [
      {
        "id": 234,
        "product": {
          "id": 10,
          "name": "Producto A",
          "code": "PROD-A"
        },
        "requestedQuantity": 100,
        "fulfilledQuantity": 100,
        "price": 20
      }
    ],
    "items": [
      {
        "id": 456,
        "barcode": "PROD10-LOTE001-0001-CONT001",
        "state": "reserved",
        "currentQuantity": 100,
        "isInvoiced": false
      }
    ],
    "subtotal": 2000,
    "taxAmount": 0,
    "totalAmount": 2000,
    "siigoId": null,
    "createdDate": "2025-01-15T10:00:00.000Z"
  }
}
```

---

## 2. Completar Orden de Venta (Despachar sin Facturar)

### Request
```bash
curl -X PUT "${API_BASE}/orders/123" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "data": {
      "state": "completed",
      "actualDispatchDate": "2025-01-15"
    }
  }'
```

### Response
```json
{
  "data": {
    "id": 123,
    "code": "SALE-2025-001",
    "type": "sale",
    "state": "completed",
    "customer": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "items": [
      {
        "id": 456,
        "barcode": "PROD10-LOTE001-0001-CONT001",
        "state": "sold",
        "currentQuantity": 100,
        "isInvoiced": false,
        "invoicedDate": null
      }
    ],
    "siigoId": null,
    "actualDispatchDate": "2025-01-15T00:00:00.000Z",
    "completedDate": "2025-01-15T10:30:00.000Z"
  }
}
```

**Nota:** Como no tiene `customerForInvoice` y no tiene `siigoId`, es una **REMISIÓN**.

---

## 3. Consultar Balance de Remisión

### Request - Balance General
```bash
curl -X GET "${API_BASE}/customers/5/consignment-balance" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Response
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
        "totalInvoiced": 0.0,
        "pendingBalance": 100.0,
        "orders": [
          {
            "orderId": 123,
            "orderCode": "SALE-2025-001",
            "dispatchDate": "2025-01-15T00:00:00.000Z",
            "invoiced": false,
            "siigoId": null,
            "dispatched": 100.0,
            "invoicedQty": 0.0,
            "pending": 100.0
          }
        ]
      }
    ],
    "summary": {
      "totalDispatched": 100.0,
      "totalInvoiced": 0.0,
      "totalPending": 100.0
    }
  },
  "meta": {}
}
```

### Request - Balance de Producto Específico
```bash
curl -X GET "${API_BASE}/customers/5/consignment-balance?product=10" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 4. Consultar Items Facturables

### Request
```bash
curl -X GET "${API_BASE}/orders/123/invoiceable-items" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Response
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
        "itemCount": 1,
        "items": [
          {
            "id": 456,
            "barcode": "PROD10-LOTE001-0001-CONT001",
            "quantity": 100.0,
            "lotNumber": "LOTE001",
            "state": "sold"
          }
        ]
      }
    ],
    "summary": {
      "totalProducts": 1,
      "totalItems": 1
    }
  },
  "meta": {}
}
```

---

## 5. Crear Factura Parcial (FIFO Automático)

### Request
```bash
curl -X POST "${API_BASE}/orders/create-partial-invoice" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "parentOrder": 123,
    "customer": 5,
    "customerForInvoice": 5,
    "products": [
      {
        "product": 10,
        "quantity": 60
      }
    ],
    "notes": "Facturación parcial - Primera venta del cliente"
  }'
```

### Response
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
    "orderProducts": [
      {
        "id": 235,
        "product": {
          "id": 10,
          "name": "Producto A",
          "code": "PROD-A"
        },
        "requestedQuantity": 60,
        "fulfilledQuantity": 60,
        "price": 20
      }
    ],
    "items": [
      {
        "id": 456,
        "barcode": "PROD10-LOTE001-0001-CONT001",
        "state": "sold",
        "currentQuantity": 100.0,
        "isInvoiced": false,
        "invoicedDate": null
      }
    ],
    "subtotal": 1200.0,
    "taxAmount": 228.0,
    "totalAmount": 1428.0,
    "notes": "Facturación parcial - Primera venta del cliente",
    "siigoId": null,
    "createdDate": "2025-01-20T10:00:00.000Z"
  },
  "meta": {
    "message": "Orden de facturación parcial creada exitosamente",
    "type": "fifo-automatic"
  }
}
```

**Nota:** El sistema seleccionó automáticamente 60kg del item más antiguo (FIFO).

---

## 6. Crear Factura Parcial (Selección Manual)

### Request
```bash
curl -X POST "${API_BASE}/orders" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "data": {
      "type": "partial-invoice",
      "parentOrder": 123,
      "customer": 5,
      "customerForInvoice": 5,
      "notes": "Facturación parcial manual - Items específicos",
      "products": [
        {
          "product": 10,
          "requestedQuantity": 60,
          "items": [
            {
              "id": 456
            }
          ]
        }
      ]
    }
  }'
```

### Response
```json
{
  "data": {
    "id": 126,
    "code": "PI-2025-002",
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
    "orderProducts": [
      {
        "id": 236,
        "product": {
          "id": 10,
          "name": "Producto A",
          "code": "PROD-A"
        },
        "requestedQuantity": 60,
        "fulfilledQuantity": 60,
        "price": 20
      }
    ],
    "items": [
      {
        "id": 456,
        "barcode": "PROD10-LOTE001-0001-CONT001",
        "state": "sold",
        "currentQuantity": 100.0,
        "isInvoiced": false,
        "invoicedDate": null
      }
    ],
    "subtotal": 1200.0,
    "taxAmount": 228.0,
    "totalAmount": 1428.0,
    "notes": "Facturación parcial manual - Items específicos",
    "siigoId": null,
    "createdDate": "2025-01-20T11:00:00.000Z"
  },
  "meta": {}
}
```

---

## 7. Completar Factura Parcial

### Request
```bash
curl -X PUT "${API_BASE}/orders/125" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "data": {
      "state": "completed"
    }
  }'
```

### Response
```json
{
  "data": {
    "id": 125,
    "code": "PI-2025-001",
    "type": "partial-invoice",
    "state": "completed",
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
    "orderProducts": [
      {
        "id": 235,
        "product": {
          "id": 10,
          "name": "Producto A",
          "code": "PROD-A"
        },
        "requestedQuantity": 60,
        "fulfilledQuantity": 60,
        "price": 20
      }
    ],
    "items": [
      {
        "id": 456,
        "barcode": "PROD10-LOTE001-0001-CONT001",
        "state": "sold",
        "currentQuantity": 100.0,
        "isInvoiced": true,
        "invoicedDate": "2025-01-20T10:30:00.000Z"
      }
    ],
    "subtotal": 1200.0,
    "taxAmount": 228.0,
    "totalAmount": 1428.0,
    "siigoId": "FV-12345",
    "invoiceNumber": "FV-12345",
    "completedDate": "2025-01-20T10:30:00.000Z"
  },
  "meta": {}
}
```

**Nota:** El item ahora tiene `isInvoiced: true` y `invoicedDate` registrada. Si Siigo está configurado, también tiene `siigoId`.

---

## 8. Verificar Balance Actualizado

### Request
```bash
curl -X GET "${API_BASE}/customers/5/consignment-balance" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Response
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

**Nota:** Ahora muestra que de 100kg despachados, 60kg están facturados y 40kg pendientes.

---

## 9. Consultar Historial de Remisión

### Request
```bash
curl -X GET "${API_BASE}/customers/5/consignment-history?startDate=2025-01-01&endDate=2025-01-31&limit=50" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Response
```json
{
  "data": [
    {
      "date": "2025-01-20T10:30:00.000Z",
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
    },
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
    }
  ],
  "meta": {
    "count": 2
  }
}
```

---

## 10. Listar Facturas Parciales

### Request - Todas
```bash
curl -X GET "${API_BASE}/orders?filters[type][\$eq]=partial-invoice&sort[0]=createdDate:desc" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Request - Solo Completadas
```bash
curl -X GET "${API_BASE}/orders?filters[type][\$eq]=partial-invoice&filters[state][\$eq]=completed&sort[0]=createdDate:desc" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Request - Solo Pendientes de Facturación
```bash
curl -X GET "${API_BASE}/orders?filters[type][\$eq]=partial-invoice&filters[siigoId][\$null]=true" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Response
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

## 11. Obtener Factura Parcial Específica

### Request
```bash
curl -X GET "${API_BASE}/orders/125?populate=*" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Response
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
      "code": "SALE-2025-001",
      "type": "sale"
    },
    "customer": {
      "id": 5,
      "name": "Cliente ABC",
      "email": "cliente@abc.com"
    },
    "customerForInvoice": {
      "id": 5,
      "name": "Cliente ABC"
    },
    "orderProducts": [...],
    "items": [...],
    "subtotal": 1200.0,
    "taxAmount": 228.0,
    "totalAmount": 1428.0,
    "notes": "Facturación parcial - Primera venta del cliente",
    "createdDate": "2025-01-20T10:00:00.000Z",
    "completedDate": "2025-01-20T10:30:00.000Z"
  },
  "meta": {}
}
```

---

## Casos de Error

### Error 1: Orden Padre No Es Remisión
**Request:**
```bash
curl -X POST "${API_BASE}/orders/create-partial-invoice" \
  -d '{
    "parentOrder": 100,
    "customer": 5,
    "customerForInvoice": 5,
    "products": [{"product": 10, "quantity": 60}]
  }'
```

**Response (400):**
```json
{
  "error": {
    "status": 400,
    "name": "PartialInvoiceCreationError",
    "message": "Orden partial-invoice inválida:\n- La orden padre ya está facturada (tiene siigoId)"
  }
}
```

### Error 2: Inventario Insuficiente
**Request:**
```bash
curl -X POST "${API_BASE}/orders/create-partial-invoice" \
  -d '{
    "parentOrder": 123,
    "products": [{"product": 10, "quantity": 200}]
  }'
```

**Response (500):**
```json
{
  "error": {
    "status": 500,
    "name": "PartialInvoiceCreationError",
    "message": "No hay suficiente inventario en remisión. Solicitado: 200, Disponible: 100"
  }
}
```

### Error 3: Item Ya Facturado
**Request:**
```bash
curl -X POST "${API_BASE}/orders" \
  -d '{
    "data": {
      "type": "partial-invoice",
      "parentOrder": 123,
      "products": [{
        "product": 10,
        "items": [{"id": 999}]
      }]
    }
  }'
```

**Response (500):**
```json
{
  "error": {
    "status": 500,
    "name": "OrderCreationError",
    "message": "Item 999 ya está facturado"
  }
}
```

---

## Scripts de Testing Completo

### Script Bash Completo
```bash
#!/bin/bash

API_BASE="http://localhost:1337/api"
TOKEN="your-auth-token"

echo "=== 1. Crear Orden de Venta (Remisión) ==="
ORDER_ID=$(curl -s -X POST "${API_BASE}/orders" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "data": {
      "type": "sale",
      "customer": 5,
      "sourceWarehouse": 1,
      "products": [
        {
          "product": 10,
          "requestedQuantity": 100,
          "price": 20,
          "items": [{"barcode": "ITEM-001", "warehouse": 1}]
        }
      ]
    }
  }' | jq -r '.data.id')

echo "Orden creada: ${ORDER_ID}"

echo "\n=== 2. Completar Orden (Despachar sin Facturar) ==="
curl -s -X PUT "${API_BASE}/orders/${ORDER_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"data": {"state": "completed"}}' | jq

echo "\n=== 3. Consultar Balance ==="
curl -s "${API_BASE}/customers/5/consignment-balance" \
  -H "Authorization: Bearer ${TOKEN}" | jq

echo "\n=== 4. Crear Factura Parcial (FIFO) ==="
INVOICE_ID=$(curl -s -X POST "${API_BASE}/orders/create-partial-invoice" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{
    \"parentOrder\": ${ORDER_ID},
    \"customer\": 5,
    \"customerForInvoice\": 5,
    \"products\": [{\"product\": 10, \"quantity\": 60}]
  }" | jq -r '.data.id')

echo "Factura creada: ${INVOICE_ID}"

echo "\n=== 5. Completar Factura ==="
curl -s -X PUT "${API_BASE}/orders/${INVOICE_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"data": {"state": "completed"}}' | jq

echo "\n=== 6. Verificar Balance Actualizado ==="
curl -s "${API_BASE}/customers/5/consignment-balance" \
  -H "Authorization: Bearer ${TOKEN}" | jq

echo "\n=== Testing Completo! ==="
```

---

## Postman Collection

Para importar en Postman, crea un archivo `partial-invoice.postman_collection.json`:

```json
{
  "info": {
    "name": "Facturación Parcial API",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "variable": [
    {
      "key": "base_url",
      "value": "http://localhost:1337/api"
    },
    {
      "key": "customer_id",
      "value": "5"
    },
    {
      "key": "order_id",
      "value": "123"
    }
  ],
  "item": [
    {
      "name": "Balance de Remisión",
      "request": {
        "method": "GET",
        "url": "{{base_url}}/customers/{{customer_id}}/consignment-balance"
      }
    },
    {
      "name": "Historial de Remisión",
      "request": {
        "method": "GET",
        "url": "{{base_url}}/customers/{{customer_id}}/consignment-history"
      }
    },
    {
      "name": "Items Facturables",
      "request": {
        "method": "GET",
        "url": "{{base_url}}/orders/{{order_id}}/invoiceable-items"
      }
    },
    {
      "name": "Crear Factura FIFO",
      "request": {
        "method": "POST",
        "url": "{{base_url}}/orders/create-partial-invoice",
        "body": {
          "mode": "raw",
          "raw": "{\n  \"parentOrder\": 123,\n  \"customer\": 5,\n  \"customerForInvoice\": 5,\n  \"products\": [{\"product\": 10, \"quantity\": 60}]\n}"
        }
      }
    }
  ]
}
```

---

## Notas Finales

1. **Autenticación:** Todos los endpoints requieren el header `Authorization: Bearer YOUR_TOKEN`
2. **Content-Type:** Usar `Content-Type: application/json` para todos los POST/PUT
3. **IDs:** Reemplazar los IDs de ejemplo con IDs reales de tu base de datos
4. **jq:** Usa `jq` para formatear las respuestas JSON en bash
5. **Populate:** Usa `?populate=*` para obtener todas las relaciones pobladas
