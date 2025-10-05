// validation/schemas.js
const { z } = require("zod");
const ITEM_STATES = require("../utils/itemStates");
const ORDER_STATES = require("../utils/orderStates");
const ORDER_TYPES = require("../utils/orderTypes");
const ITEM_MOVEMENT_TYPES = require("../utils/itemMovementTypes");

// Reusables
const UnitEnum = z.enum(["kg", "m", "roll", "unit"]);
const OrderType = z.enum(Object.values(ORDER_TYPES));
const OrderState = z.enum(Object.values(ORDER_STATES));
const ItemState = z.enum(Object.values(ITEM_STATES));
const ItemMovementType = z.enum(Object.values(ITEM_MOVEMENT_TYPES));
const ID = z.union([z.string(), z.number()]).transform(Number);
const TRX = z.any().optional().default(null);
const Item = z.object({
  id: z.union([ID, z.null()]).optional().default(null),
  barcode: z
    .union([z.union([z.string(), z.number()]).transform(String), z.null()])
    .optional()
    .default(null),
  product: z.union([ID, z.null()]).optional().default(null),
  sourceWarehouse: z.union([ID, z.null()]).optional().default(null),
  quantity: z.union([z.number(), z.null()]).optional().default(null),
  lot: z
    .union([z.union([z.number(), z.string()]).transform(String), z.null()])
    .optional()
    .default(null),
  itemNumber: z
    .union([z.union([z.number(), z.string()]).transform(String), z.null()])
    .optional()
    .default(null),
  containerCode: z
    .union([z.union([z.number(), z.string()]).transform(String), z.null()])
    .optional()
    .default(null),
  parentItem: z
    .union([z.object({ id: ID }), z.null()])
    .optional()
    .default(null),
  warehouse: z.union([ID, z.null()]).optional().default(null),
});

// Schema para creación de Item
const CreateItemSchema = z.object({
  quantity: z.number().positive(),
  product: z.object({
    id: ID,
    unit: UnitEnum,
    barcode: z.string(),
    name: z.string(),
    code: z.string(),
  }),
  state: ItemState,
  sourceOrder: ID,
  containerCode: z
    .union([z.string(), z.number()])
    .transform(String)
    .optional()
    .default(null),
  orderProduct: ID,
  lot: z.union([z.string(), z.number()]).transform(String),
  itemNumber: z.union([z.string(), z.number()]).transform(String),
  warehouse: ID,
  trx: TRX,
});

// Schema para borrado de Item
const DeleteItemSchema = z
  .object({
    id: ID,
    trx: TRX,
    order: ID,
    orderProduct: ID,
  })
  .strict();

const UpdateItemSchema = z
  .object({
    id: z.union([ID, z.null()]).optional().default(null),
    barcode: z
      .union([z.string(), z.number().transform(String), z.null()])
      .optional()
      .default(null),
    quantity: z.union([z.number(), z.null()]).optional().default(null),
    product: z.union([ID, z.null()]).optional().default(null),
    update: z
      .object({
        order: ID.optional().default(null),
        orderProduct: ID.optional().default(null),
      })
      .catchall(z.any())
      .optional()
      .default({ order: null, orderProduct: null }),
    populate: z.array(z.string()).optional().default(null),
    type: OrderType,
    reverse: z.boolean().default(false),
    justAvailableItems: z.boolean().default(true),
    trx: TRX,
    sourceWarehouse: z.union([ID, z.null()]).optional().default(null),
    orderState: OrderState.optional().default(null),
  })
  .catchall(z.any());

const CreateOrderProductSchema = z
  .object({
    product: ID,
    order: ID,
    quantity: z.number().optional().default(null),
    requestedQuantity: z.number(),
    requestedPackages: z.number().optional().default(null),
    confirmedQuantity: z.number().optional().default(null),
    confirmedPackages: z.number().optional().default(null),
    deliveredQuantity: z.number().optional().default(null),
    deliveredPackages: z.number().optional().default(null),
    unit: UnitEnum.optional().default(null),
    notes: z.string().optional().default(""),
    price: z.number().optional().default(null),
    trx: TRX,
  })
  .catchall(z.any());
const UpdateOrderProductSchema = z.object({
  id: ID,
  update: z
    .object({
      items: z
        .array(
          z
            .object({
              id: ID,
              currentQuantity: z.number(),
              state: ItemState,
            })
            .catchall(z.any())
        )
        .optional()
        .default(null),
    })
    .catchall(z.any())
    .optional()
    .default({ items: null }),
  orderState: OrderState,
  populate: z.array(z.string()).optional().default([]),
  trx: TRX,
});
const DeleteOrderProductSchema = z
  .object({
    id: ID,
    trx: TRX,
  })
  .strict();

const CreateOrderSchema = z
  .object({
    type: OrderType,
    products: z
      .array(
        z.object({
          product: ID,
          requestedQuantity: z.number(),
          items: z
            .array(
              z.object({
                product: ID.optional().default(null),
                quantity: z.number(),
                lot: z
                  .union([z.number(), z.string()])
                  .transform(String)
                  .optional()
                  .default(null),
                itemNumber: z
                  .union([z.number(), z.string()])
                  .transform(String)
                  .optional()
                  .default(null),
                containerCode: z
                  .union([z.number(), z.string()])
                  .transform(String)
                  .optional()
                  .default(null),
                parentItem: z.object({}).catchall(z.any()).default({}),
              })
            )
            .optional()
            .default([]),
          price: z.number().optional().default(null),
          name: z.string().optional().default(null),
        })
      )
      .optional()
      .default([]),
    destinationWarehouse: ID.optional().default(null),
    sourceWarehouse: ID.optional().default(null),
    supplier: ID.optional(),
    customer: ID.optional(),
    generatedBy: ID.optional(),
  })
  .catchall(z.any());
const UpdateOrderSchema = z.object({
  id: ID,
  products: z
    .array(
      z.object({
        orderProduct: ID.optional().default(null),
        product: ID,
        items: z.array(Item).optional().default([]),
        requestedQuantity: z.number().optional().default(null),
      })
    )
    .optional()
    .default([]),
  update: z.object({}).catchall(z.any()).optional().default({}),
});
const DeleteOrderSchema = z.object({
  id: ID,
  trx: TRX,
});
const InventoryByWarehouseSchema = z.object({
  warehouses: z.array(ID).optional().default([]),
  isActive: z.boolean().optional().default(true),
});
const InventoryByProductSchema = z.object({
  products: z.array(ID).optional().default([]),
});

const DoItemMovementSchema = z.object({
  movementType: ItemMovementType,
  item: z.object().catchall(z.any()),
  order: z
    .object({
      id: ID,
      type: OrderType,
      destinationWarehouse: z
        .union([
          z
            .object({
              id: ID,
            })
            .optional(),
          z.null(),
        ])
        .optional()
        .default(null),
      sourceWarehouse: z
        .union([
          z
            .object({
              id: ID,
            })
            .optional(),
          z.null(),
        ])
        .optional()
        .default(null),
    })
    .catchall(z.any())
    .optional(),
  product: z.object({}).catchall(z.any()),
  orderProduct: z.object({}).catchall(z.any()),
  orderState: OrderState,
  reverse: z.boolean().optional().default(false),
});
const AddItemToOrderSchema = z.object({
  id: ID,
  item: Item,
  product: ID,
});
const RemoveItemFromOrderSchema = z.object({
  id: ID,
  item: ID,
});

module.exports = {
  CreateItemSchema,
  DeleteItemSchema,
  UpdateItemSchema,
  CreateOrderProductSchema,
  UpdateOrderProductSchema,
  DeleteOrderProductSchema,
  CreateOrderSchema,
  UpdateOrderSchema,
  DeleteOrderSchema,
  InventoryByWarehouseSchema,
  InventoryByProductSchema,
  DoItemMovementSchema,
  AddItemToOrderSchema,
  RemoveItemFromOrderSchema,
};
