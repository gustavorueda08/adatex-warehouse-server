"use strict";

const moment = require("moment-timezone");

/**
 * Servicio de mapeo de datos de Strapi a formato Siigo
 */

module.exports = ({ strapi }) => ({
  /**
   * Mapea una Order de Strapi al formato de factura de Siigo
   * @param {Object} order - Order con populate de orderProducts, customerForInvoice, etc.
   * @returns {Object} - JSON en formato Siigo
   */
  async mapOrderToInvoice(order) {
    try {
      // Validaciones iniciales
      if (!order) {
        throw new Error("Order es requerido para mapear a factura");
      }

      if (order.type !== "sale") {
        throw new Error(
          "Solo las órdenes de tipo 'sale' pueden convertirse en facturas"
        );
      }

      if (order.state !== "completed") {
        throw new Error(
          "Solo las órdenes en estado 'completed' pueden facturarse"
        );
      }

      if (!order.customerForInvoice) {
        throw new Error(
          "La orden debe tener un customerForInvoice para facturar"
        );
      }

      const customer = order.customerForInvoice;

      // Validar que el cliente tenga siigoId
      if (!customer.siigoId) {
        throw new Error(
          `El cliente ${customer.name} (ID: ${customer.id}) no tiene siigoId. Debe sincronizarse con Siigo primero.`
        );
      }

      if (!customer.identification) {
        throw new Error(
          `El cliente ${customer.name} no tiene número de identificación`
        );
      }

      // Validar que haya orderProducts
      if (!order.orderProducts || order.orderProducts.length === 0) {
        throw new Error("La orden no tiene productos para facturar");
      }

      // Mapear items de la factura
      const items = await this.mapOrderProductsToItems(
        order.orderProducts,
        customer
      );

      // Calcular fecha de vencimiento según términos de pago
      const paymentTermsDays = customer.paymentTerms || 0;
      const dueDate = moment()
        .add(paymentTermsDays, "days")
        .format("YYYY-MM-DD");

      // Construir objeto de factura en formato Siigo
      const invoice = {
        document: {
          id: parseInt(process.env.SIIGO_INVOICE_DOCUMENT_ID || 1), // ID del tipo de documento FV
        },
        date: moment().format("YYYY-MM-DD"),
        customer: {
          identification: customer.identification,
          branch_office: 0, // Por defecto sucursal 0
        },
        cost_center: process.env.SIIGO_COST_CENTER_ID
          ? parseInt(process.env.SIIGO_COST_CENTER_ID)
          : undefined,
        seller: process.env.SIIGO_SELLER_ID
          ? parseInt(process.env.SIIGO_SELLER_ID)
          : undefined,
        observations: order.notes || `Factura generada automáticamente - Orden: ${order.code}`,
        items: items,
        payments: [
          {
            id: parseInt(process.env.SIIGO_PAYMENT_METHOD_ID || 1), // ID forma de pago
            value: parseFloat(order.totalAmount),
            due_date: dueDate,
          },
        ],
      };

      // Agregar currency si está configurado
      if (order.currency && order.currency !== "COP") {
        invoice.currency = {
          code: order.currency,
          exchange_rate: 1, // Ajustar según necesidad
        };
      }

      return invoice;
    } catch (error) {
      console.error("Error al mapear orden a factura Siigo:", error.message);
      throw error;
    }
  },

  /**
   * Mapea orderProducts a items de factura Siigo
   * @param {Array} orderProducts - Array de orderProducts con populate de product
   * @param {Object} customerForInvoice - Customer con taxes
   * @returns {Array} - Array de items en formato Siigo
   */
  async mapOrderProductsToItems(orderProducts, customerForInvoice) {
    const items = [];

    for (const orderProduct of orderProducts) {
      if (!orderProduct.product) {
        throw new Error(
          `OrderProduct ID ${orderProduct.id} no tiene producto asociado`
        );
      }

      const product = orderProduct.product;

      // Validar que el producto tenga siigoId
      if (!product.siigoId) {
        throw new Error(
          `El producto ${product.name} (Code: ${product.code}) no tiene siigoId. Debe sincronizarse con Siigo primero.`
        );
      }

      // Calcular cantidad a facturar según invoicePercentage
      const invoicePercentage = orderProduct.invoicePercentage || 100;
      const quantityToInvoice =
        (orderProduct.confirmedQuantity * invoicePercentage) / 100;

      if (quantityToInvoice <= 0) {
        continue; // Saltar productos con cantidad 0
      }

      // Obtener taxes del producto/cliente
      const taxes = this.getProductTaxes(orderProduct, customerForInvoice);

      const item = {
        code: product.siigoId, // Usar siigoId como código en la factura
        description: product.name,
        quantity: parseFloat(quantityToInvoice.toFixed(2)),
        price: parseFloat(orderProduct.price),
        discount: 0, // Agregar lógica de descuento si aplica
      };

      // Agregar taxes si existen
      if (taxes.length > 0) {
        item.taxes = taxes;
      }

      items.push(item);
    }

    if (items.length === 0) {
      throw new Error("No hay items válidos para facturar");
    }

    return items;
  },

  /**
   * Obtiene los taxes aplicables a un producto
   * @param {Object} orderProduct - OrderProduct
   * @param {Object} customerForInvoice - Customer con taxes
   * @returns {Array} - Array de taxes en formato Siigo
   */
  getProductTaxes(orderProduct, customerForInvoice) {
    try {
      const taxes = [];

      // Verificar si el customer tiene taxes configurados
      if (!customerForInvoice || !customerForInvoice.taxes || customerForInvoice.taxes.length === 0) {
        return taxes;
      }

      // Mapear taxes del customer a formato Siigo
      for (const tax of customerForInvoice.taxes) {
        // Validar que el tax tenga siigoCode
        if (!tax.siigoCode) {
          console.warn(
            `Tax "${tax.name}" no tiene siigoCode configurado, se omitirá en la factura`
          );
          continue;
        }

        // Verificar si el tax aplica según su applicationType
        let shouldApply = false;

        switch (tax.applicationType) {
          case "product":
            // Se aplica a nivel de producto
            shouldApply = true;
            break;
          case "subtotal":
            // Se aplica a nivel de subtotal (no va en items, va en el invoice general)
            shouldApply = false;
            break;
          case "auto":
            // Se aplica automáticamente
            shouldApply = true;
            break;
          default:
            shouldApply = false;
        }

        // Si el tax tiene threshold, verificar si se cumple la condición
        if (shouldApply && tax.treshold && tax.treshold > 0 && tax.tresholdContidion) {
          const itemTotal = orderProduct.price * orderProduct.confirmedQuantity;

          switch (tax.tresholdContidion) {
            case "greaterThan":
              shouldApply = itemTotal > tax.treshold;
              break;
            case "lessThan":
              shouldApply = itemTotal < tax.treshold;
              break;
            case "greaterThanOrEqualTo":
              shouldApply = itemTotal >= tax.treshold;
              break;
            case "lessThanOrEqualTo":
              shouldApply = itemTotal <= tax.treshold;
              break;
          }
        }

        if (shouldApply) {
          // Formato de tax para Siigo: solo necesita el ID
          taxes.push({
            id: parseInt(tax.siigoCode), // siigoCode es el ID del tax en Siigo
          });
        }
      }

      return taxes;
    } catch (error) {
      console.error("Error al obtener taxes:", error.message);
      return [];
    }
  },

  /**
   * Valida que todos los datos requeridos estén presentes antes de enviar a Siigo
   * @param {Object} order - Order a validar
   * @returns {Object} - { valid: boolean, errors: [] }
   */
  async validateOrderForInvoicing(order) {
    const errors = [];

    // Validar tipo y estado
    if (order.type !== "sale") {
      errors.push("La orden debe ser de tipo 'sale'");
    }

    if (order.state !== "completed") {
      errors.push("La orden debe estar en estado 'completed'");
    }

    // Validar que no tenga ya una factura
    if (order.siigoId) {
      errors.push(
        `La orden ya tiene una factura asociada en Siigo (ID: ${order.siigoId})`
      );
    }

    // Validar customer
    if (!order.customerForInvoice) {
      errors.push("La orden debe tener un customerForInvoice");
    } else {
      if (!order.customerForInvoice.siigoId) {
        errors.push(
          `El cliente ${order.customerForInvoice.name} no está sincronizado con Siigo`
        );
      }
      if (!order.customerForInvoice.identification) {
        errors.push(
          `El cliente ${order.customerForInvoice.name} no tiene número de identificación`
        );
      }
    }

    // Validar productos
    if (!order.orderProducts || order.orderProducts.length === 0) {
      errors.push("La orden no tiene productos");
    } else {
      for (const op of order.orderProducts) {
        if (!op.product) {
          errors.push(`OrderProduct ID ${op.id} no tiene producto asociado`);
        } else if (!op.product.siigoId) {
          errors.push(
            `Producto ${op.product.name} no está sincronizado con Siigo`
          );
        }
      }
    }

    // Validar montos
    if (!order.totalAmount || order.totalAmount <= 0) {
      errors.push("La orden no tiene un monto total válido");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
});
