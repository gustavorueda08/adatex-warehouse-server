# Especificación Frontend: Página New Transform

## Descripción General

La página **New Transform** permite crear órdenes de transformación que convierten items de inventario de un producto a otro, o dividen items del mismo producto (particiones/cortes).

### Tipos de Operaciones

1. **Transformación**: Convertir items de un producto A a un producto B diferente (ej: 10 kg de tela → 40 metros de tela cortada)
2. **Partición/Corte**: Dividir items del mismo producto en items más pequeños (ej: cortar 20 kg de un rollo de 100 kg)

---

## Estructura del Formulario

### Campos Principales del Formulario

#### 1. Información General de la Orden

```typescript
interface TransformOrderForm {
  type: "transform";                    // FIJO, no editable
  destinationWarehouse: number;         // ID del warehouse destino (requerido)
  transformationFactor?: number;        // Opcional, ej: 4 (1kg → 4m)
  notes?: string;                       // Notas adicionales
  products: TransformProduct[];         // Array de productos a transformar
}
```

**Campos de UI:**
- **Warehouse de Destino** (Select/Dropdown)
  - Requerido
  - Lista de warehouses disponibles del backend
  - GET `/api/warehouses`

- **Factor de Transformación** (Number Input)
  - Opcional
  - Útil para reportes (ej: "1 kg genera 4 metros")
  - Placeholder: "Ej: 4 (1kg → 4m)"

- **Notas** (Textarea)
  - Opcional
  - Para comentarios adicionales

#### 2. Productos a Transformar (Array)

Cada producto en el array tiene esta estructura:

```typescript
interface TransformProduct {
  product: number;                      // ID del producto DESTINO
  requestedQuantity: number;            // Cantidad total a crear
  items: TransformItem[];               // Items origen a consumir
}
```

**Campos de UI por Producto:**

- **Producto Destino** (Select/Autocomplete)
  - Requerido
  - Búsqueda de productos disponibles
  - GET `/api/products?filters[isActive][$eq]=true`
  - Muestra: código, nombre, unidad

- **Cantidad Solicitada** (Number Input)
  - Requerido
  - Cantidad total que se creará del producto destino
  - Unidad: debe mostrarse junto al input (se obtiene del producto seleccionado)

- **Items a Consumir** (Array dinámico - ver siguiente sección)

#### 3. Items a Consumir por Producto (Array)

Cada item en el array tiene esta estructura:

```typescript
interface TransformItem {
  sourceItemId: number;                 // ID del item origen (requerido)
  sourceQuantityConsumed: number;       // Cantidad a consumir del origen (requerido)
  targetQuantity: number;               // Cantidad resultante en destino (requerido)
  warehouse?: number;                   // Warehouse (opcional, usa destinationWarehouse si no se proporciona)
  lotNumber?: string;                   // Número de lote para el nuevo item (opcional)
  itemNumber?: string;                  // Número de item para el nuevo item (opcional)
}
```

**Campos de UI por Item:**

- **Item Origen** (Select/Autocomplete con búsqueda avanzada)
  - Requerido
  - Permite buscar por:
    - Código de barras
    - Nombre de producto
    - Item number
  - GET `/api/items?filters[state][$eq]=available&filters[currentQuantity][$gt]=0&populate=product,warehouse`
  - Muestra en cada opción:
    - Barcode del item
    - Nombre del producto
    - Cantidad disponible actual (ej: "25.5 kg disponibles")
    - Warehouse donde está ubicado
  - Al seleccionar, auto-completar el warehouse si está vacío

- **Cantidad a Consumir** (Number Input)
  - Requerido
  - Validación: debe ser ≤ cantidad disponible del item origen
  - Mostrar unidad del producto origen
  - Mostrar debajo: "Disponible: X [unidad]"

- **Cantidad Resultante** (Number Input)
  - Requerido
  - Cantidad del nuevo item que se creará
  - Mostrar unidad del producto destino
  - Ayuda visual: "Del producto destino"

- **Warehouse** (Select - opcional)
  - Por defecto usa el `destinationWarehouse` de la orden
  - Permite sobreescribirlo para casos específicos

- **Número de Lote** (Text Input - opcional)
  - Hereda del item origen si no se especifica
  - Placeholder: "Heredará del item origen"

- **Número de Item** (Text Input - opcional)
  - Para identificación del nuevo item
  - Placeholder: "Ej: 001"

---

## UX/UI Recomendaciones

### Layout Sugerido

```
┌─────────────────────────────────────────────────────┐
│ Nueva Transformación                                 │
├─────────────────────────────────────────────────────┤
│                                                      │
│ [Warehouse Destino ▼]  [Factor Transformación]     │
│                                                      │
│ [Notas ________________________________]             │
│                                                      │
│ ┌───────────────────────────────────────────────┐   │
│ │ Producto a Transformar #1                     │   │
│ │                                               │   │
│ │ [Producto Destino ▼]  [Cantidad: ___ m]      │   │
│ │                                               │   │
│ │ ┌─ Item Origen #1 ────────────────────────┐  │   │
│ │ │ [Seleccionar Item ▼]                    │  │   │
│ │ │ Disponible: 25.5 kg en Warehouse A      │  │   │
│ │ │                                          │  │   │
│ │ │ Cantidad a Consumir: [___] kg           │  │   │
│ │ │ Cantidad Resultante: [___] m            │  │   │
│ │ │                                          │  │   │
│ │ │ [Warehouse ▼] [Lote ___] [Item# ___]   │  │   │
│ │ │                                 [❌ Quitar] │  │   │
│ │ └─────────────────────────────────────────┘  │   │
│ │                                               │   │
│ │ [+ Agregar Item Origen]                      │   │
│ │                                      [❌ Quitar] │   │
│ └───────────────────────────────────────────────┘   │
│                                                      │
│ [+ Agregar Producto]                                │
│                                                      │
│                    [Cancelar] [Crear Transformación]│
└─────────────────────────────────────────────────────┘
```

### Flujo de Usuario

1. **Seleccionar Warehouse Destino** (obligatorio al inicio)
2. **Agregar Producto Destino**
   - Seleccionar qué producto se creará
   - Definir cantidad total
3. **Agregar Items Origen**
   - Por cada producto destino, agregar uno o más items origen
   - Definir cantidades a consumir y resultantes
4. **Revisar y Crear**
   - Validaciones automáticas
   - Mostrar resumen antes de crear

### Casos de Uso en UI

#### Caso 1: Transformación Simple (Producto A → Producto B)

**Usuario quiere**: Transformar 10 kg de tela en 40 metros de tela cortada

**Pasos en UI**:
1. Selecciona "Warehouse Principal" como destino
2. Agrega producto destino: "Tela Cortada (PD-02)" - 40 metros
3. Agrega item origen:
   - Selecciona item "TELA-001" (Tela Original, 25 kg disponibles)
   - Consume: 10 kg
   - Genera: 40 metros
4. Crea la orden

**Payload resultante**:
```json
{
  "data": {
    "type": "transform",
    "destinationWarehouse": 1,
    "transformationFactor": 4,
    "products": [{
      "product": 2,
      "requestedQuantity": 40,
      "items": [{
        "sourceItemId": 123,
        "sourceQuantityConsumed": 10,
        "targetQuantity": 40,
        "warehouse": 1,
        "lotNumber": "LOT-2025-01",
        "itemNumber": "001"
      }]
    }]
  }
}
```

#### Caso 2: Partición (Cortar del mismo producto)

**Usuario quiere**: Cortar 20 kg de un rollo de 100 kg

**Pasos en UI**:
1. Selecciona "Warehouse Principal"
2. Agrega producto destino: **Mismo producto que el origen** (ej: "Tela Original (PD-01)") - 20 kg
3. Agrega item origen:
   - Selecciona item "TELA-ROLLO-001" (100 kg disponibles)
   - Consume: 20 kg
   - Genera: 20 kg (mismo valor)
4. Crea la orden

**Detección automática**: El backend detecta que es una partición porque `sourceItem.product.id === targetProduct.id`

#### Caso 3: Múltiples Items Origen

**Usuario quiere**: Crear 50 metros usando material de 2 rollos diferentes

**Pasos en UI**:
1. Selecciona warehouse destino
2. Agrega producto destino: "Tela Cortada" - 50 metros
3. Agrega primer item origen:
   - Item A: consume 8 kg → genera 30 metros
4. Agrega segundo item origen (botón "+ Agregar Item Origen"):
   - Item B: consume 5 kg → genera 20 metros
5. Crea la orden

---

## Validaciones en Frontend

### Validaciones Obligatorias

```typescript
// Validación 1: Warehouse destino requerido
if (!form.destinationWarehouse) {
  errors.push("Debe seleccionar un warehouse destino");
}

// Validación 2: Al menos un producto
if (form.products.length === 0) {
  errors.push("Debe agregar al menos un producto a transformar");
}

// Validación 3: Por cada producto
form.products.forEach((product, index) => {
  if (!product.product) {
    errors.push(`Producto ${index + 1}: Debe seleccionar un producto destino`);
  }

  if (!product.requestedQuantity || product.requestedQuantity <= 0) {
    errors.push(`Producto ${index + 1}: La cantidad solicitada debe ser mayor a 0`);
  }

  if (product.items.length === 0) {
    errors.push(`Producto ${index + 1}: Debe agregar al menos un item origen`);
  }

  // Validación 4: Por cada item
  product.items.forEach((item, itemIndex) => {
    if (!item.sourceItemId) {
      errors.push(`Producto ${index + 1}, Item ${itemIndex + 1}: Debe seleccionar un item origen`);
    }

    if (!item.sourceQuantityConsumed || item.sourceQuantityConsumed <= 0) {
      errors.push(`Producto ${index + 1}, Item ${itemIndex + 1}: La cantidad a consumir debe ser mayor a 0`);
    }

    if (!item.targetQuantity || item.targetQuantity <= 0) {
      errors.push(`Producto ${index + 1}, Item ${itemIndex + 1}: La cantidad resultante debe ser mayor a 0`);
    }

    // Validación 5: Verificar que hay suficiente cantidad disponible
    const sourceItem = fetchedItems.find(i => i.id === item.sourceItemId);
    if (sourceItem && item.sourceQuantityConsumed > sourceItem.currentQuantity) {
      errors.push(
        `Producto ${index + 1}, Item ${itemIndex + 1}: ` +
        `Solo hay ${sourceItem.currentQuantity} ${sourceItem.unit} disponibles, ` +
        `pero se intentan consumir ${item.sourceQuantityConsumed}`
      );
    }
  });
});
```

### Validaciones Recomendadas (Warnings)

```typescript
// Warning 1: Verificar suma de cantidades
const totalTargetQuantity = product.items.reduce((sum, item) => sum + item.targetQuantity, 0);
if (totalTargetQuantity !== product.requestedQuantity) {
  warnings.push(
    `Producto ${index + 1}: La suma de cantidades resultantes (${totalTargetQuantity}) ` +
    `no coincide con la cantidad solicitada (${product.requestedQuantity})`
  );
}

// Warning 2: Factor de transformación inconsistente
if (form.transformationFactor) {
  const actualFactor = item.targetQuantity / item.sourceQuantityConsumed;
  if (Math.abs(actualFactor - form.transformationFactor) > 0.1) {
    warnings.push(
      `El factor real (${actualFactor.toFixed(2)}) difiere del factor especificado (${form.transformationFactor})`
    );
  }
}
```

---

## API Endpoints a Consumir

### 1. Obtener Warehouses
```http
GET /api/warehouses
Response: Array<{ id: number, name: string, code: string }>
```

### 2. Obtener Productos
```http
GET /api/products?filters[isActive][$eq]=true
Response: Array<{
  id: number,
  name: string,
  code: string,
  unit: "kg" | "m" | "piece" | "unit",
  barcode: string
}>
```

### 3. Buscar Items Disponibles
```http
GET /api/items?filters[state][$eq]=available&filters[currentQuantity][$gt]=0&populate=product,warehouse

Response: Array<{
  id: number,
  barcode: string,
  currentQuantity: number,
  unit: "kg" | "m" | "piece" | "unit",
  lotNumber: string,
  itemNumber: string,
  product: {
    id: number,
    name: string,
    code: string,
    unit: string
  },
  warehouse: {
    id: number,
    name: string
  }
}>
```

### 4. Crear Orden de Transformación
```http
POST /api/orders
Content-Type: application/json

Body:
{
  "data": {
    "type": "transform",
    "destinationWarehouse": 1,
    "transformationFactor": 4,  // Opcional
    "notes": "...",             // Opcional
    "products": [
      {
        "product": 2,
        "requestedQuantity": 40,
        "items": [
          {
            "sourceItemId": 123,
            "sourceQuantityConsumed": 10,
            "targetQuantity": 40,
            "warehouse": 1,        // Opcional
            "lotNumber": "LOT-001", // Opcional
            "itemNumber": "001"     // Opcional
          }
        ]
      }
    ]
  }
}

Response:
{
  "data": {
    "id": 456,
    "code": "TF-251014-1",
    "type": "transform",
    "state": "draft",
    ...
  },
  "meta": {}
}
```

---

## Helpers/Utils Sugeridos para Frontend

### 1. Helper para detectar si es partición

```typescript
function isPartition(sourceProduct: Product, targetProduct: Product): boolean {
  return sourceProduct.id === targetProduct.id;
}
```

### 2. Helper para calcular factor de transformación

```typescript
function calculateTransformationFactor(
  sourceQuantity: number,
  targetQuantity: number
): number {
  return targetQuantity / sourceQuantity;
}
```

### 3. Helper para formatear display de items

```typescript
function formatItemDisplay(item: Item): string {
  return `${item.barcode} - ${item.product.name} (${item.currentQuantity} ${item.unit} en ${item.warehouse.name})`;
}
```

### 4. Hook de validación en tiempo real

```typescript
function useTransformValidation(form: TransformOrderForm) {
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    // Ejecutar validaciones
    const newErrors: string[] = [];
    const newWarnings: string[] = [];

    // ... validaciones aquí

    setErrors(newErrors);
    setWarnings(newWarnings);
  }, [form]);

  return { errors, warnings, isValid: errors.length === 0 };
}
```

---

## Estados y Feedback

### Estados de Carga

1. **Cargando warehouses**: Mostrar skeleton en select
2. **Buscando items**: Mostrar spinner en autocomplete
3. **Creando orden**: Deshabilitar botón, mostrar spinner

### Mensajes de Éxito

```typescript
// Después de crear exitosamente
toast.success(
  `Transformación ${response.data.code} creada exitosamente`
);
// Redirigir a la página de detalle o lista
navigate(`/orders/${response.data.id}`);
```

### Manejo de Errores

```typescript
try {
  await createTransformOrder(formData);
} catch (error) {
  if (error.response?.status === 400) {
    // Errores de validación del backend
    toast.error(error.response.data.error.message);
  } else if (error.response?.status === 404) {
    toast.error("Item origen no encontrado");
  } else {
    toast.error("Error al crear la transformación");
  }
}
```

---

## Ejemplo Completo de Payload

### Transformación Compleja con Múltiples Items

```json
{
  "data": {
    "type": "transform",
    "destinationWarehouse": 1,
    "transformationFactor": 4,
    "notes": "Transformación de telas para pedido urgente",
    "products": [
      {
        "product": 2,
        "requestedQuantity": 100,
        "items": [
          {
            "sourceItemId": 101,
            "sourceQuantityConsumed": 15,
            "targetQuantity": 60,
            "warehouse": 1,
            "lotNumber": "LOT-2025-01",
            "itemNumber": "A001"
          },
          {
            "sourceItemId": 102,
            "sourceQuantityConsumed": 10,
            "targetQuantity": 40,
            "warehouse": 1,
            "lotNumber": "LOT-2025-01",
            "itemNumber": "A002"
          }
        ]
      },
      {
        "product": 3,
        "requestedQuantity": 50,
        "items": [
          {
            "sourceItemId": 103,
            "sourceQuantityConsumed": 8,
            "targetQuantity": 50,
            "warehouse": 1,
            "lotNumber": "LOT-2025-02",
            "itemNumber": "B001"
          }
        ]
      }
    ]
  }
}
```

---

## Notas Importantes

### Comportamiento del Backend

1. **Detección automática**: El backend detecta si es transformación o partición basándose en si el producto origen es igual al producto destino
2. **Relaciones automáticas**:
   - Particiones → se crea relación `parentItem`
   - Transformaciones → se crea relación `transformedFromItem`
3. **Movimientos de inventario**: Se crean automáticamente 2 ItemMovements por cada item (uno negativo en origen, uno positivo en destino)
4. **Código de orden**: Se genera automáticamente con formato `TF-YYMMDD-N`

### Permisos y Restricciones

- Solo se pueden editar/eliminar transformaciones en estado `draft` o `confirmed`
- La eliminación revierte todos los cambios (restaura cantidades al item origen)
- Solo items en estado `available` pueden ser transformados

### Mejoras Futuras Sugeridas

1. **Escáner de código de barras**: Permitir escanear items directamente
2. **Plantillas**: Guardar configuraciones frecuentes de transformación
3. **Vista previa**: Mostrar cómo quedarán los items después de la transformación
4. **Calculadora de factor**: Auto-calcular factor basado en las cantidades
5. **Historial**: Mostrar transformaciones previas del mismo tipo

---

## Testing Recomendado

### Casos de Prueba

1. ✅ Crear transformación simple (1 producto, 1 item origen)
2. ✅ Crear partición (mismo producto origen y destino)
3. ✅ Crear transformación con múltiples items origen
4. ✅ Validar error cuando cantidad consumida > cantidad disponible
5. ✅ Validar que no se puede enviar formulario vacío
6. ✅ Verificar que el factor de transformación se calcula correctamente
7. ✅ Probar con diferentes unidades (kg → m, m → piece, etc.)
8. ✅ Verificar manejo de errores del backend

---

## Recursos Adicionales

- Ver guía completa del backend: `TRANSFORM_ORDER_GUIDE.md`
- Schema de Order: `src/api/order/content-types/order/schema.json`
- Schema de Item: `src/api/item/content-types/item/schema.json`
- Estrategia de transformación: `src/api/order/strategies/itemMovementStrategies.js` (líneas 406-643)
