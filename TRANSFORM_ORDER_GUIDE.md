# Guía de Órdenes de Transformación

## Descripción

El tipo de orden **"transform"** permite realizar dos tipos de operaciones:

1. **Transformaciones**: Convertir items de un producto a otro producto diferente (con diferentes unidades y cantidades)
2. **Particiones/Cortes**: Dividir items del mismo producto en items más pequeños

Ambas operaciones pueden ser **parciales** (solo una parte del item) o **totales** (todo el item).

## Casos de Uso

### 1. Transformación entre productos diferentes

**Ejemplo**: Transformar 10 kg de tela (PD-01) en 40 metros de producto cortado (PD-02)

```javascript
{
  type: "transform",
  destinationWarehouse: 1,
  products: [{
    product: 2, // ID del producto destino (PD-02)
    requestedQuantity: 40,
    items: [{
      sourceItemId: 123, // ID del item origen (PD-01 con 25kg)
      sourceQuantityConsumed: 10, // Cantidad a consumir del item origen
      targetQuantity: 40, // Cantidad resultante en el nuevo producto
      warehouse: 1,
      lotNumber: "LOT-2025-01",
      itemNumber: "001"
    }]
  }]
}
```

**Resultado**:
- Item PD-01 (id: 123): `25kg → 15kg` (queda residual de 15kg)
- Item PD-02 (nuevo): `0m → 40m` (creado con 40m)
- ItemMovements creados:
  - TRANSFORM OUT en item 123: -10kg
  - TRANSFORM IN en nuevo item: +40m

### 2. Partición/Corte del mismo producto

**Ejemplo**: Cortar 20 kg de un rollo de 100 kg para crear un item hijo

```javascript
{
  type: "transform",
  destinationWarehouse: 1,
  products: [{
    product: 1, // ID del producto origen (mismo producto PD-01)
    requestedQuantity: 20,
    items: [{
      sourceItemId: 456, // ID del item padre (PD-01 con 100kg)
      sourceQuantityConsumed: 20, // Cantidad a cortar
      targetQuantity: 20, // Cantidad del item hijo (igual a la consumida)
      warehouse: 1,
      lotNumber: "LOT-2025-01",
      itemNumber: "002"
    }]
  }]
}
```

**Resultado**:
- Item PD-01 padre (id: 456): `100kg → 80kg` (queda 80kg)
- Item PD-01 hijo (nuevo): `0kg → 20kg` (creado con 20kg, tiene `parentItem = 456`)
- ItemMovements creados:
  - TRANSFORM OUT en item 456: -20kg
  - TRANSFORM IN en nuevo item hijo: +20kg

### 3. Transformación total (consumir todo el item)

**Ejemplo**: Transformar completamente un item de 25kg en 100m

```javascript
{
  type: "transform",
  products: [{
    product: 2,
    requestedQuantity: 100,
    items: [{
      sourceItemId: 789,
      sourceQuantityConsumed: 25, // Todo el item
      targetQuantity: 100,
      warehouse: 1
    }]
  }]
}
```

**Resultado**:
- Item origen: `25kg → 0kg` (consumido totalmente)
- Item destino: `0m → 100m` (creado)

### 4. Múltiples transformaciones en una orden

**Ejemplo**: Cortar varios items del mismo rollo

```javascript
{
  type: "transform",
  products: [{
    product: 1, // Mismo producto
    requestedQuantity: 35,
    items: [
      {
        sourceItemId: 100,
        sourceQuantityConsumed: 20,
        targetQuantity: 20,
        warehouse: 1
      },
      {
        sourceItemId: 100, // Mismo item origen
        sourceQuantityConsumed: 15,
        targetQuantity: 15,
        warehouse: 1
      }
    ]
  }]
}
```

**Resultado**:
- Item padre (id: 100): `100kg → 65kg` (100 - 20 - 15)
- Item hijo 1: `20kg`
- Item hijo 2: `15kg`

## Relaciones en Items

El sistema utiliza dos tipos de relaciones para trazabilidad:

### Para Particiones (mismo producto):
- `parentItem`: Referencia al item padre del que se particionó
- `childItems`: Items hijos creados desde este item
- `isPartition: true`

### Para Transformaciones (producto diferente):
- `transformedFromItem`: Referencia al item que se transformó
- `transformedItems`: Items creados por transformación desde este item

## ItemMovements

Cada operación de transformación crea **2 ItemMovements**:

1. **Movement del item origen** (tipo: TRANSFORM)
   - `quantity`: Negativa (cantidad consumida)
   - `balanceBefore`: Cantidad original
   - `balanceAfter`: Cantidad restante

2. **Movement del item destino** (tipo: TRANSFORM)
   - `quantity`: Positiva (cantidad creada)
   - `balanceBefore`: 0
   - `balanceAfter`: Cantidad creada

## Reversión de Transformaciones

Al eliminar una orden de tipo "transform" (solo en estado draft/confirmed):

1. Se elimina el item transformado/particionado
2. Se restaura la cantidad al item origen
3. Se crean ItemMovements de reversión
4. Se mantiene trazabilidad completa

## Factor de Transformación (Opcional)

Puedes agregar un factor de transformación en el Order:

```javascript
{
  type: "transform",
  transformationFactor: 4, // 1kg → 4m
  products: [...]
}
```

Este campo es informativo y útil para reportes.

## Códigos de Orden

Las órdenes de transformación tienen el prefijo **"TF"**:
- Formato: `TF-YYMMDD-N`
- Ejemplo: `TF-250109-1` (primera transformación del 9 de enero de 2025)

## Validaciones

- El item origen debe existir
- Debe haber suficiente cantidad: `currentQuantity >= sourceQuantityConsumed`
- `sourceItemId` es obligatorio
- `sourceQuantityConsumed` y `targetQuantity` son obligatorios
- Solo se pueden editar/eliminar órdenes en estado draft o confirmed

## API Endpoints

### Crear orden de transformación
```
POST /api/orders
Content-Type: application/json

{
  "data": {
    "type": "transform",
    "destinationWarehouse": 1,
    "products": [...]
  }
}
```

### Eliminar (revertir) orden de transformación
```
DELETE /api/orders/:orderId
```

Solo permitido en estados: draft, confirmed
