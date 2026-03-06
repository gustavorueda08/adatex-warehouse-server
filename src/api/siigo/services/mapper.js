"use strict";

const moment = require("moment-timezone");
const formatName = require("../../../utils/formatName");
const units = require("../../../utils/units");
const productCategories = require("../../../utils/productCategories");

/**
 * Servicio de mapeo de datos de Strapi a formato Siigo
 */

module.exports = ({ strapi }) => ({
  /**
   * Mapea una Order de Strapi al formato de factura de Siigo
   * @param {Object} order - Order con populate de orderProducts, customerForInvoice, etc.
   * @param {Number} documentType - Tipo de documento (1 = tipo A electrónica, 2 = tipo B normal)
   * @returns {Object} - JSON en formato Siigo
   */
  async mapOrderToInvoice(order, documentType = 1, paymentTermType = 2810) {
    try {
      // Validaciones iniciales
      if (!order) {
        throw new Error("Order es requerido para mapear a factura");
      }

      if (order.type !== "sale") {
        throw new Error(
          "Solo las órdenes de tipo 'sale' pueden convertirse en facturas",
        );
      }

      if (order.state !== "completed") {
        throw new Error(
          "Solo las órdenes en estado 'completed' pueden facturarse",
        );
      }

      if (!order.customerForInvoice) {
        throw new Error(
          "La orden debe tener un customerForInvoice para facturar",
        );
      }

      const customer = order.customerForInvoice;
      const seller = order.customer.seller;

      // Validar que el cliente tenga siigoId
      if (!customer.siigoId) {
        throw new Error(
          `El cliente ${customer.name} (ID: ${customer.id}) no tiene siigoId. Debe sincronizarse con Siigo primero.`,
        );
      }

      if (!customer.identification) {
        throw new Error(
          `El cliente ${customer.name} no tiene número de identificación`,
        );
      }

      if (!seller) {
        throw new Error(
          `El cliente ${customer.name} no tiene un vendedor asignado`,
        );
      }

      if (!seller.siigoCode) {
        throw new Error(
          `El vendedor ${seller.name} no tiene número de identificación en siigo`,
        );
      }

      // Validar que haya orderProducts
      if (!order.orderProducts || order.orderProducts.length === 0) {
        throw new Error("La orden no tiene productos para facturar");
      }

      // Mapear items de la factura
      const items = await this.mapOrderProductsToItems(
        order.orderProducts,
        customer,
      );

      // Calcular totales de la factura
      let invoiceSubtotal = 0;
      let invoiceTaxes = 0;
      let invoiceTotalBeforeRetentions = 0;

      // [NUEVO] Validar taxes de tipo 'product-depending-subtotal'
      // Primero calculamos un subtotal preliminar para validar la condición
      let preliminarySubtotal = 0;
      for (const item of items) {
        if (item.taxed_price) {
          // Si tiene impuesto incluido (IVA 19%), la base es ~ precio / 1.19
          preliminarySubtotal += (item.taxed_price / 1.19) * item.quantity;
        } else {
          preliminarySubtotal += item.price * item.quantity;
        }
      }

      if (customer && customer.taxes && customer.taxes.length > 0) {
        const subtotalDependentTaxes = [];

        for (const tax of customer.taxes) {
          if (
            tax.applicationType === "product-depending-subtotal" &&
            tax.siigoCode
          ) {
            let shouldApply = true;
            // Verificar condición y threshold con el subtotal preliminar
            if (tax.treshold && tax.treshold > 0 && tax.tresholdContidion) {
              shouldApply = false;
              switch (tax.tresholdContidion) {
                case "greaterThan":
                  shouldApply = preliminarySubtotal > tax.treshold;
                  break;
                case "lessThan":
                  shouldApply = preliminarySubtotal < tax.treshold;
                  break;
                case "greaterThanOrEqualTo":
                  shouldApply = preliminarySubtotal >= tax.treshold;
                  break;
                case "lessThanOrEqualTo":
                  shouldApply = preliminarySubtotal <= tax.treshold;
                  break;
              }
            }

            if (shouldApply) {
              subtotalDependentTaxes.push({
                id: parseInt(tax.siigoCode),
              });
            }
          }
        }

        if (subtotalDependentTaxes.length > 0) {
          for (const item of items) {
            if (!item.taxes) item.taxes = [];
            for (const newTax of subtotalDependentTaxes) {
              if (!item.taxes.find((t) => t.id === newTax.id)) {
                item.taxes.push(newTax);
              }
            }
          }
        }
      }

      // Cálculo final de totales recorriendo items
      for (const item of items) {
        if (item.taxed_price) {
          // Caso: Precio con IVA incluido (taxed_price)
          // El total de la línea es exactamente quantity * taxed_price (respetando precisión)
          const lineTotal = item.taxed_price * item.quantity;

          // Calculamos base inversa para reportes y retenciones (asumiendo IVA 19%)
          // Siigo hará esto internamente, pero nosotros lo necesitamos para invoiceSubtotal
          const lineBase = lineTotal / 1.19;

          invoiceSubtotal += lineBase;
          invoiceTotalBeforeRetentions += lineTotal;

          // La diferencia es el impuesto implícito en taxed_price
          invoiceTaxes += lineTotal - lineBase;
        } else {
          // Caso: Precio base sin IVA (price)
          const lineBase = item.price * item.quantity;
          invoiceSubtotal += lineBase;

          let lineTaxes = 0;
          if (item.taxes && item.taxes.length > 0) {
            // Calcular impuestos adicionales
            for (const itemTax of item.taxes) {
              const taxDef = customer.taxes.find(
                (t) => parseInt(t.siigoCode) === itemTax.id,
              );
              if (taxDef) {
                const rate = this._getEffectiveTaxRate(taxDef);
                const taxAmount = lineBase * rate;
                if (taxDef.use === "decrement") {
                  lineTaxes -= taxAmount;
                } else {
                  lineTaxes += taxAmount;
                }
              }
            }
          }
          invoiceTaxes += lineTaxes;
          invoiceTotalBeforeRetentions += lineBase + lineTaxes;
        }
      }

      // Redondeos finales para visualización y consistencia
      invoiceSubtotal = Math.round(invoiceSubtotal * 100) / 100;
      invoiceTaxes = Math.round(invoiceTaxes * 100) / 100;

      // Calcular retenciones basadas en el subtotal
      const retentions = this.getSubtotalTaxes(invoiceSubtotal, customer);

      let retentionsAmount = 0;
      if (customer?.taxes?.length > 0) {
        // Lógica de cálculo de retenciones (ya existente, mantenida pero usando el nuevo invoiceSubtotal)
        for (const tax of customer.taxes) {
          if (tax.applicationType === "subtotal" && tax.siigoCode) {
            // ...re-validación de threshold con el subtotal final redondeado...
            let shouldApply = true;
            if (tax.treshold && tax.treshold > 0 && tax.tresholdContidion) {
              switch (tax.tresholdContidion) {
                case "greaterThan":
                  shouldApply = invoiceSubtotal > tax.treshold;
                  break;
                case "lessThan":
                  shouldApply = invoiceSubtotal < tax.treshold;
                  break;
                case "greaterThanOrEqualTo":
                  shouldApply = invoiceSubtotal >= tax.treshold;
                  break;
                case "lessThanOrEqualTo":
                  shouldApply = invoiceSubtotal <= tax.treshold;
                  break;
              }
            }
            if (shouldApply) {
              const rate = this._getEffectiveTaxRate(tax);
              const val = invoiceSubtotal * rate;
              const roundedVal = Math.round(val * 100) / 100;
              if (tax.use === "decrement") retentionsAmount -= roundedVal;
              else retentionsAmount += roundedVal;
            }
          }
        }
      }
      retentionsAmount = Math.round(retentionsAmount * 100) / 100;

      // Total final
      const invoiceTotal =
        Math.round((invoiceTotalBeforeRetentions + retentionsAmount) * 100) /
        100;

      console.log("=== Cálculo de factura DETALLADO (V2 Taxed Price) ===");
      console.log(`Subtotal: ${invoiceSubtotal}`);
      console.log(`Impuestos (aprox/calc): ${invoiceTaxes}`);
      console.log(`Retenciones: ${retentionsAmount}`);
      console.log(`Total a pagar: ${invoiceTotal}`);

      // Log de items para debug profundo
      console.log("--- Detalle Items ---");
      items.forEach((item, idx) => {
        const lineTotal = Math.round(item.price * item.quantity * 100) / 100;
        console.log(
          `#${idx + 1} Code: ${item.code} | Price: ${item.price} | Qty: ${item.quantity} | Total: ${lineTotal}`,
        );
      });
      console.log("================================");

      // Calcular fecha de vencimiento según términos de pago
      const paymentTermsDays = customer.paymentTerms || 0;
      const dueDate = moment()
        .add(paymentTermsDays, "days")
        .format("YYYY-MM-DD");

      // Construir objeto de factura en formato Siigo
      const invoice = {
        document: {
          id: documentType, // 1 = tipo A (electrónica), 2 = tipo B (normal)
        },
        date: moment().format("YYYY-MM-DD"),
        customer: {
          identification: customer.identification,
        },
        cost_center: process.env.SIIGO_COST_CENTER_ID
          ? parseInt(process.env.SIIGO_COST_CENTER_ID)
          : undefined,
        seller: order.customer.seller.siigoCode,
        observations:
          order.notes ||
          `Factura generada automáticamente - Orden: ${order.code}`,
        items: items,
        stamp: {
          send: false,
        },
        payments: [
          {
            id: paymentTermType, // ID forma de pago
            value: invoiceTotal, // Usar el total calculado desde los items
            due_date: dueDate,
          },
        ],
      };

      // Agregar retentions solo si existen

      if (retentions.length > 0) {
        invoice.retentions = retentions;
      }
      console.log(invoice);
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
          `OrderProduct ID ${orderProduct.id} no tiene producto asociado`,
        );
      }
      const product = orderProduct.product;
      // Validar que el producto tenga siigoId
      if (!product.siigoId) {
        throw new Error(
          `El producto ${product.name} (Code: ${product.code}) no tiene siigoId. Debe sincronizarse con Siigo primero.`,
        );
      }
      // La cantidad ya viene ajustada por invoicePercentage desde splitOrderProductsForDualInvoices
      const quantityToInvoice = orderProduct.confirmedQuantity || 0;
      if (quantityToInvoice <= 0) {
        continue; // Saltar productos con cantidad 0
      }
      
      // Calcular precio base (sin IVA si viene incluido)
      let basePrice = parseFloat(orderProduct.price);
      if (isNaN(basePrice) || basePrice <= 0) {
        console.log(`Saltando producto ${product.code} por ser regalo (precio 0 o inválido).`);
        continue; // Saltar productos que son regalos o no tienen precio
      }
      
      const originalPrice = basePrice;
      let taxedPrice = undefined;

      // Si el precio incluye IVA, calculamos base para 'price' y enviamos 'taxed_price'
      if (orderProduct.ivaIncluded === true) {
        // Calcular base price con hasta 6 decimales para minimizar errores de redondeo
        // 14500 / 1.19 = 12184.873949... -> 12184.873950
        basePrice = Number((originalPrice / 1.19).toFixed(6));
        // Asegurar que el precio con impuestos tampoco exceda 6 decimales (por seguridad)
        taxedPrice = Number(originalPrice.toFixed(6));

        console.log(
          `Producto ${product.code}: IVA incluido via taxed_price. Base (6 dec): ${basePrice}, Taxed: ${taxedPrice}`,
        );
      } else {
        // Lógica estándar para precios sin IVA
        // Redondear a 2 decimales para consistencia
        basePrice = Math.round(basePrice * 100) / 100;
      }

      // Obtener taxes del producto/cliente
      const taxes = this.getProductTaxes(orderProduct, customerForInvoice);
      const item = {
        code: product.code || product.siigoId, // Usar siigoId como código en la factura
        quantity: Math.round(quantityToInvoice * 100) / 100, // Redondear a 2 decimales
        price: basePrice, // OBLIGATORIO: Precio base (sin impuestos)
        discount: 0, // Agregar lógica de descuento si aplica
      };

      if (taxedPrice !== undefined) {
        item.taxed_price = taxedPrice;
      }
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
   * Helper para obtener la tasa real del impuesto.
   * Si el nombre del impuesto incluye un porcentaje (e.g. "2.5%"), intenta usar ese valor
   * si la diferencia con el valor almacenado es significativa (problemas de redondeo en DB).
   */
  _getEffectiveTaxRate(tax) {
    let rate = parseFloat(tax.amount) || 0;

    // Si el nombre tiene formato de porcentaje, intentamos validar
    if (tax.name && tax.name.includes("%")) {
      try {
        // Buscar patrón como "2.5%" o "2,5%"
        const match = tax.name.match(/(\d+[.,]?\d*)%/);
        if (match && match[1]) {
          const stringVal = match[1].replace(",", ".");
          const nameRate = parseFloat(stringVal) / 100;

          // Si la diferencia es mayor a 0.001 (e.g. 0.03 vs 0.025), confiamos en el nombre
          // Esto arregla el caso donde 2.5% se guardó como 0.03 por redondeo
          if (Math.abs(rate - nameRate) > 0.001) {
            console.warn(
              `[TAX-FIX] Tax "${tax.name}" tiene valor ${rate} pero el nombre indica ${nameRate}. Usando ${nameRate}.`,
            );
            return nameRate;
          }
        }
      } catch (e) {
        // Ignorar errores de parsing, fallback al valor de DB
      }
    }
    return rate;
  },

  /**
   * Obtiene la tasa total de impuestos para un cliente
   * Solo considera taxes a nivel de producto (applicationType: "product")
   * Distingue entre increment (suma) y decrement (resta)
   * @param {Object} customer - Customer con taxes
   * @returns {Number} - Tasa de impuesto total como decimal (e.g., 0.19 para 19% IVA)
   */
  _getCustomerTaxRate(customer) {
    if (!customer || !customer.taxes || customer.taxes.length === 0) {
      return 0;
    }
    // Solo procesar taxes de tipo "product" (los de subtotal se manejan en retentions)
    const productTaxes = customer.taxes.filter(
      ({ applicationType }) => applicationType === "product",
    );
    let totalRate = 0;
    for (const tax of productTaxes) {
      const taxAmount = this._getEffectiveTaxRate(tax);
      // Sumar si es increment (IVA), restar si es decrement (retenciones a nivel de producto)
      if (tax.use === "decrement") {
        totalRate -= taxAmount;
      } else {
        // Por defecto se suma (increment o sin especificar)
        totalRate += taxAmount;
      }
    }
    return totalRate;
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
            `Tax "${tax.name}" no tiene siigoCode configurado, se omitirá en la factura`,
          );
          continue;
        }

        console.log(tax);

        // Verificar si el tax aplica según su applicationType
        let shouldApply = tax.applicationType === "product";

        // Si el tax tiene threshold configurado, verificar si se cumple la condición
        // Los taxes sin threshold (como IVA) se aplican directamente según su applicationType
        if (shouldApply && tax.treshold && tax.treshold > 0) {
          // Solo evaluar threshold si también hay una condición definida
          if (tax.tresholdContidion) {
            const itemTotal =
              orderProduct.price * orderProduct.confirmedQuantity;
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
        }
        if (shouldApply) {
          // Formato de tax para Siigo: solo necesita el ID
          taxes.push({
            id: parseInt(tax.siigoCode), // siigoCode es el ID del tax en Siigo
          });
        }
      }
      console.log("IMPUESTOS", taxes);
      return taxes;
    } catch (error) {
      console.error("Error al obtener taxes:", error.message);
      return [];
    }
  },

  /**
   * Obtiene los taxes aplicables al subtotal de la orden (retenciones)
   * @param {Number} subtotal - Subtotal de la orden (antes de IVA)
   * @param {Object} customerForInvoice - Customer con taxes
   * @returns {Array} - Array de taxes en formato Siigo para retentions
   */
  getSubtotalTaxes(subtotal, customerForInvoice) {
    try {
      const retentions = [];

      // Verificar si el customer tiene taxes configurados
      if (
        !customerForInvoice ||
        !customerForInvoice.taxes ||
        customerForInvoice.taxes.length === 0
      ) {
        return retentions;
      }

      // Filtrar taxes que aplican a nivel de subtotal
      for (const tax of customerForInvoice.taxes) {
        // Validar que el tax tenga siigoCode
        if (!tax.siigoCode) {
          console.warn(
            `Tax "${tax.name}" no tiene siigoCode configurado, se omitirá en retenciones`,
          );
          continue;
        }

        // Verificar si el tax aplica según su applicationType
        // Soporte para 'subtotal' (retenciones normales) y 'self-retention' (autoretenciones informativas)
        let shouldApply =
          tax.applicationType === "subtotal" ||
          tax.applicationType === "self-retention";

        // Si el tax tiene threshold configurado, verificar si se cumple la condición
        if (shouldApply && tax.treshold && tax.treshold > 0) {
          // Solo evaluar threshold si también hay una condición definida
          if (tax.tresholdContidion) {
            switch (tax.tresholdContidion) {
              case "greaterThan":
                shouldApply = subtotal > tax.treshold;
                break;
              case "lessThan":
                shouldApply = subtotal < tax.treshold;
                break;
              case "greaterThanOrEqualTo":
                shouldApply = subtotal >= tax.treshold;
                break;
              case "lessThanOrEqualTo":
                shouldApply = subtotal <= tax.treshold;
                break;
            }
          }
        }

        if (shouldApply) {
          // Formato de retention para Siigo: solo necesita el ID
          console.log(
            `Adding retention from tax: ${tax.name} (Siigo Code: ${tax.siigoCode})`,
          );
          retentions.push({
            id: parseInt(tax.siigoCode),
          });
        }
      }

      console.log("RETENCIONES (subtotal taxes):", retentions);
      return retentions;
    } catch (error) {
      console.error("Error al obtener retenciones:", error.message);
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
    if (order.type !== "sale" && order.type !== "partial-invoice") {
      errors.push("La orden debe ser de tipo 'sale' o 'partial-invoice'");
    }

    if (order.state !== "completed") {
      errors.push("La orden debe estar en estado 'completed'");
    }

    // Validar que no tenga ya una factura (verificar ambos campos por retrocompatibilidad)
    if (order.siigoIdTypeA || order.siigoId) {
      const invoiceId = order.siigoIdTypeA || order.siigoId;
      errors.push(
        `La orden ya tiene una factura asociada en Siigo (ID: ${invoiceId})`,
      );
    }

    // Validar customer
    if (!order.customerForInvoice) {
      errors.push("La orden debe tener un customerForInvoice");
    } else {
      if (!order.customerForInvoice.siigoId) {
        errors.push(
          `El cliente ${order.customerForInvoice.name} no está sincronizado con Siigo`,
        );
      }
      if (!order.customerForInvoice.identification) {
        errors.push(
          `El cliente ${order.customerForInvoice.name} no tiene número de identificación`,
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
            `Producto ${op.product.name} no está sincronizado con Siigo`,
          );
        }
      }
    }

    // Validar montos
    /*
    if (!order.totalAmount || order.totalAmount <= 0) {
      errors.push("La orden no tiene un monto total válido");
    }*/

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
    // Determinar si es persona o empresa basado en el nombre o tipo de ID
    const isCompany =
      customer.identificationType === "NIT" || customer.isCompany === true;

    const siigoCustomer = {
      type: "Customer",
      person_type: isCompany ? "Company" : "Person",
      id_type: customer.identificationType === "NIT" ? "31" : "13",
      identification: customer.identification,
      name: isCompany
        ? [[customer.name, customer.lastName].filter(Boolean).join(" ")]
        : [customer.name, customer.lastName].filter(Boolean),
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
        ...(customer.seller
          ? [
              {
                first_name: customer.seller.name,
                last_name: customer.seller.lastName || "",
                email: customer.seller.email || "",
                phone: {
                  number: customer.seller.phone || "",
                },
              },
            ]
          : []),
      ];
      siigoCustomer.email = customer.email || "";
      siigoCustomer.phones = [{ number: customer.phone || "" }];
    }

    // Agregar dirección si existe
    if (customer.address) {
      const territory = customer.territory;

      siigoCustomer.address = {
        address: customer.address,
        city: {
          country_code: territory?.countryCode || "Co", // Colombia por defecto
          state_code: territory?.stateCode || "76", // Valle del Cauca por defecto (coincide con 76001)
          city_code: territory?.code || "76001", // Cali por defecto
        },
        postal_code: territory?.code || customer?.postalCode || "76001",
      };
    }

    if (customer.seller) {
      siigoCustomer.related_users = {
        seller_id: customer.seller.siigoCode,
        collector_id: customer.seller.siigoCode,
      };
    }

    if (customer.companyName) {
      siigoCustomer.commercial_name = customer.companyName;
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
      isActive: siigoCustomer.active !== false,
    };

    // Name mapping
    if (Array.isArray(siigoCustomer.name)) {
      localCustomer.name = formatName(siigoCustomer.name[0]);
      if (siigoCustomer.name.length > 1) {
        localCustomer.lastName = formatName(
          siigoCustomer.name.slice(1).join(" "),
        );
      }
    } else {
      localCustomer.name = formatName(siigoCustomer.name);
    }

    // Identification Type
    // Siigo puede devolver id_type como objeto { code, name } o como string/number
    const idTypeCode = siigoCustomer.id_type?.code || siigoCustomer.id_type;
    const idType = String(idTypeCode);

    if (idType === "13") {
      localCustomer.identificationType = "CC";
    } else if (idType === "31") {
      localCustomer.identificationType = "NIT";
    }

    // Is Company
    // Siigo devuelve "Person" o "Company" (implícito si es NIT)
    // El usuario indicó que person_type viene en la respuesta
    localCustomer.isCompany = siigoCustomer.person_type === "Company";

    // Contacts
    if (siigoCustomer.contacts && siigoCustomer.contacts.length > 0) {
      const contact = siigoCustomer.contacts[0];
      localCustomer.email = contact.email || "";
      if (contact.phone && contact.phone.number) {
        localCustomer.phone = contact.phone.number;
      }
    }

    // Address & Territory
    if (siigoCustomer.address) {
      localCustomer.address = siigoCustomer.address.address || "";

      if (siigoCustomer.address.city && siigoCustomer.address.city.city_code) {
        const cityCode = siigoCustomer.address.city.city_code;
        // Buscar territorio por código
        try {
          const territories = await strapi.entityService.findMany(
            "api::territory.territory",
            {
              filters: { code: cityCode },
              limit: 1,
            },
          );

          if (territories && territories.length > 0) {
            localCustomer.territory = territories[0].id;
          }
        } catch (error) {
          console.warn(
            `No se pudo vincular territorio para código ${cityCode}:`,
            error.message,
          );
        }
      }

      // Mapear postalCode si existe en el modelo (aunque no lo vi en el schema, lo dejo por si acaso o lo quito?)
      // El schema NO tiene postalCode. Lo quito para evitar errores si strict mode está activo.
    }

    // Payment Terms
    if (siigoCustomer.payment_terms) {
      localCustomer.paymentTerms = siigoCustomer.payment_terms.days || 0;
    }

    // Seller
    if (siigoCustomer.related_users && siigoCustomer.related_users.seller_id) {
      const sellerId = String(siigoCustomer.related_users.seller_id);
      try {
        const sellers = await strapi.entityService.findMany(
          "api::seller.seller",
          {
            filters: { siigoCode: sellerId },
            limit: 1,
          },
        );

        if (sellers && sellers.length > 0) {
          localCustomer.seller = sellers[0].id;
        }
      } catch (error) {
        console.warn(
          `No se pudo vincular vendedor para ID ${sellerId}:`,
          error.message,
        );
      }
    }

    if (siigoCustomer.commercial_name) {
      localCustomer.companyName = siigoCustomer.commercial_name;
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
      identification: supplier.identification, // Usar identification (NIT/CC)
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
    const rawName = Array.isArray(siigoSupplier.name)
      ? siigoSupplier.name.join(" ")
      : siigoSupplier.name;

    const localSupplier = {
      siigoId: String(siigoSupplier.id),
      identification: siigoSupplier.identification,
      name: formatName(rawName),
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
      code: product.code
        ? String(product.code)
            .toUpperCase()
            .trim()
            .replace(/[\s]+/g, "-")
            .replace(/[^\w-]/g, "")
        : product.code,
      name: product.name,
      description: product.description || product.name,
      type: product.type === "service" ? "Service" : "Product",
      active: product.isActive !== false,
    };

    if (product.type === "service") {
      siigoProduct.stock_control = false;
    }

    // Mapear unidad de medida
    const unitObj = units.find((u) => u.value === product.unit);
    // Si no encuentra, usa "94" (Unidad) por defecto. Se envía como string (código).
    siigoProduct.unit = unitObj ? unitObj.code : "94";

    // Agregar barcode como reference
    if (product.barcode && product.type !== "service") {
      siigoProduct.reference = product.barcode;
    }

    // Agregar account_group (requerido por Siigo)
    const categoryObj = productCategories.find(
      (c) => c.value === product.category,
    );
    siigoProduct.account_group = categoryObj ? categoryObj.id : 625; // 625 = Confección (default)

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
      name: formatName(siigoProduct.name),
      description: siigoProduct.description || "",
      isActive: siigoProduct.active !== false,
      barcode: siigoProduct?.additional_fields?.barcode || "",
    };
    const unitCode = siigoProduct.unit?.code || siigoProduct.unit;
    const unit = units.find((u) => u.code == unitCode);
    localProduct.unit = unit ? unit.value : "unit";
    const category = productCategories.find(
      (c) => c.id == siigoProduct?.account_group?.id,
    );
    localProduct.category = category ? category.value : "Confeccion";
    return localProduct;
  },
});
