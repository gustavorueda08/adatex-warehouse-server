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
      const seller = order.customer.seller;

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

      if (!seller && !seller?.siigoCode) {
        throw new Error(
          `El vendedor ${seller.name} no tiene número de identificación en siigo`
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
        observations:
          order.notes ||
          `Factura generada automáticamente - Orden: ${order.code}`,
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
      if (
        !customerForInvoice ||
        !customerForInvoice.taxes ||
        customerForInvoice.taxes.length === 0
      ) {
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
        if (
          shouldApply &&
          tax.treshold &&
          tax.treshold > 0 &&
          tax.tresholdContidion
        ) {
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

  /**
   * ============================================
   * MAPEOS BIDIRECCIONALES
   * ============================================
   */

  /**
   * Mapea un Tax de Siigo a formato local
   * @param {Object} siigoTax - Tax de Siigo
   * @returns {Object} - Tax en formato local
   */
  mapSiigoToTax(siigoTax) {
    return {
      name: siigoTax.name || `Tax ${siigoTax.id}`,
      amount: parseFloat(siigoTax.percentage || 0),
      type: "percentage", // Siigo maneja principalmente porcentajes
      applicationType: "auto",
      siigoCode: String(siigoTax.id),
      use: "increment", // Por defecto incremento (IVA)
    };
  },

  /**
   * Mapea un Tax local a formato Siigo
   * @param {Object} localTax - Tax local
   * @returns {Object} - Tax en formato Siigo
   */
  mapTaxToSiigo(localTax) {
    return {
      id: localTax.siigoCode ? parseInt(localTax.siigoCode) : null,
      name: localTax.name,
      percentage: parseFloat(localTax.amount),
    };
  },

  /**
   * Mapea un Customer local a formato Siigo
   * @param {Object} customer - Customer local con populate de taxes
   * @returns {Object} - Customer en formato Siigo
   */
  async mapCustomerToSiigo(customer) {
    // Determinar si es persona o empresa basado en el nombre
    const isCompany = customer.identificationType === "NIT" ? true : false;

    const siigoCustomer = {
      type: "Customer",
      person_type: isCompany ? "Company" : "Person",
      id_type: customer.identificationType === "NIT" ? "31" : "13",
      identification: customer.identification,
      name: !isCompany ? [customer.name, customer.lastName] : customer.name,
      active: customer.isActive,
      fiscal_responsibilities: [{ code: "R-99-PN" }],
    };

    // Agregar contactos si hay email o phone
    if (customer.email || customer.phone) {
      siigoCustomer.contacts = [
        {
          first_name: customer.name,
          last_name: customer.lastName || "",
          email: customer.email || "",
          phone: {
            number: customer.phone || "",
          },
        },
      ];
    }

    // Agregar dirección si existe
    if (customer.address) {
      const territory = customer.territory;

      siigoCustomer.address = {
        address: customer.address,
        city: {
          country_code: territory?.countryCode || "Co", // Colombia por defecto
          state_code: territory?.stateCode || "19", // Código por defecto
          city_code: territory?.code || "76001", // Cali por defecto
        },
        postal_code: territory?.code || customer?.postalCode || "",
      };
    }

    if (customer.seller) {
      siigoCustomer.related_users = {
        seller_id: customer.seller.siigoId,
        collector_id: customer.seller.siigoId,
      };
    }

    return siigoCustomer;
  },

  /**
   * Mapea un Customer de Siigo a formato local
   * @param {Object} siigoCustomer - Customer de Siigo
   * @returns {Object} - Customer en formato local
   */
  async mapSiigoToCustomer(siigoCustomer) {
    const localCustomer = {
      siigoId: String(siigoCustomer.id),
      identification: siigoCustomer.identification,
      name: Array.isArray(siigoCustomer.name)
        ? siigoCustomer.name.join(" ")
        : siigoCustomer.name,
      isActive: siigoCustomer.active !== false,
    };

    // Extraer email y phone del primer contacto
    if (siigoCustomer.contacts && siigoCustomer.contacts.length > 0) {
      const contact = siigoCustomer.contacts[0];
      localCustomer.email = contact.email || "";
      if (contact.phone && contact.phone.number) {
        localCustomer.phone = contact.phone.number;
      }
    }

    // Extraer dirección
    if (siigoCustomer.address) {
      localCustomer.address = siigoCustomer.address.address || "";
      if (siigoCustomer.address.city) {
        localCustomer.cityCode = siigoCustomer.address.city.city_code;
      }
      localCustomer.postalCode = siigoCustomer.address.postal_code || "";
    }

    // Extraer términos de pago
    if (siigoCustomer.payment_terms) {
      localCustomer.paymentTerms = siigoCustomer.payment_terms.days || 0;
    }

    return localCustomer;
  },

  /**
   * Mapea un Supplier local a formato Siigo
   * @param {Object} supplier - Supplier local
   * @returns {Object} - Supplier en formato Siigo (como Customer tipo Provider)
   */
  async mapSupplierToSiigo(supplier) {
    const siigoSupplier = {
      type: "Supplier",
      person_type: "Company",
      id_type: "31", // NIT
      identification: supplier.code, // Usar code como identification
      name: [supplier.name],
      active: supplier.isActive !== false,
    };

    // Agregar contacto si hay email
    if (supplier.email) {
      siigoSupplier.contacts = [
        {
          first_name: supplier.name,
          last_name: "",
          email: supplier.email,
        },
      ];
    }

    // Agregar dirección
    if (supplier.address) {
      siigoSupplier.address = {
        address: supplier.address,
        city: {
          country_code: supplier.country || "Co",
          state_code: supplier.state || "19",
          city_code: supplier.cityCode || "001",
        },
        postal_code: supplier.postalCode || "",
      };
    }

    return siigoSupplier;
  },

  /**
   * Mapea un Supplier de Siigo a formato local
   * @param {Object} siigoSupplier - Supplier de Siigo
   * @returns {Object} - Supplier en formato local
   */
  async mapSiigoToSupplier(siigoSupplier) {
    const localSupplier = {
      siigoId: String(siigoSupplier.id),
      code: siigoSupplier.identification,
      name: Array.isArray(siigoSupplier.name)
        ? siigoSupplier.name.join(" ")
        : siigoSupplier.name,
      isActive: siigoSupplier.active !== false,
    };

    // Extraer email del primer contacto
    if (siigoSupplier.contacts && siigoSupplier.contacts.length > 0) {
      localSupplier.email = siigoSupplier.contacts[0].email || "";
    }

    // Extraer dirección
    if (siigoSupplier.address) {
      localSupplier.address = siigoSupplier.address.address || "";
      if (siigoSupplier.address.city) {
        localSupplier.country = siigoSupplier.address.city.country_code || "Co";
        localSupplier.state = siigoSupplier.address.city.state_code || "";
        localSupplier.cityCode = siigoSupplier.address.city.city_code || "";
      }
      localSupplier.postalCode = siigoSupplier.address.postal_code || "";
    }

    return localSupplier;
  },

  /**
   * Mapea un Product local a formato Siigo
   * @param {Object} product - Product local con populate de taxes
   * @returns {Object} - Product en formato Siigo
   */
  async mapProductToSiigo(product) {
    const siigoProduct = {
      code: product.code,
      name: product.name,
      description: product.description || product.name,
      type: "Product", // Por defecto producto
      active: product.isActive !== false,
    };

    // Mapear unidad de medida
    const unitMap = {
      kg: "Kilogram",
      m: "Meter",
      unit: "Unit",
      piece: "Unit",
    };
    siigoProduct.unit = unitMap[product.unit] || "Unit";

    // Agregar barcode como reference
    if (product.barcode) {
      siigoProduct.reference = product.barcode;
    }

    // Agregar account_group (requerido por Siigo)
    siigoProduct.account_group = parseInt(
      process.env.SIIGO_PRODUCT_ACCOUNT_GROUP || "1"
    );

    // Clasificación fiscal (por defecto gravado)
    siigoProduct.tax_classification = "Taxed";

    return siigoProduct;
  },

  /**
   * Mapea un Product de Siigo a formato local
   * @param {Object} siigoProduct - Product de Siigo
   * @returns {Object} - Product en formato local
   */
  async mapSiigoToProduct(siigoProduct) {
    const localProduct = {
      siigoId: String(siigoProduct.id),
      code: siigoProduct.code,
      name: siigoProduct.name,
      description: siigoProduct.description || "",
      isActive: siigoProduct.active !== false,
    };

    // Mapear unidad de medida inversa
    const unitMap = {
      Kilogram: "kg",
      Meter: "m",
      Unit: "unit",
    };
    localProduct.unit = unitMap[siigoProduct.unit] || "unit";

    // Usar reference como barcode si existe
    if (siigoProduct.reference) {
      localProduct.barcode = siigoProduct.reference;
    } else {
      localProduct.barcode = siigoProduct.code; // Fallback
    }

    return localProduct;
  },
});
