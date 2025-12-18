"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const nodemailer = require("nodemailer");
const moment = require("moment-timezone");
const logger = require("../../../utils/logger");
const { ORDER_SERVICE } = require("../../../utils/services");
const { generatePackingListPDF } = require("./packing-list-pdf");

/**
 * Servicio encargado de generar la lista de empaque y enviarla por correo al seller.
 */
module.exports = ({ strapi }) => ({
  /**
   * Procesa las órdenes completadas que aún no tienen lista de empaque enviada.
   * Se ejecuta vía Cron.
   */
  async processPendingOrders() {
    try {
      logger.info("Cron: Buscando órdenes pendientes de lista de empaque...");

      // Buscar órdenes completadas recientemente (últimas 24h) para no escanear toda la DB
      // y que NO tengan una factura asociada (aunque validamos eso después)
      const since = moment().subtract(24, "hours").toISOString();

      const orders = await strapi.entityService.findMany(ORDER_SERVICE, {
        filters: {
          state: "completed",
          updatedAt: { $gte: since },
        },
        populate: ["attachments", "customer", "customer.seller"],
      });

      let processedCount = 0;

      for (const order of orders) {
        // Verificar si ya tiene lista de empaque en adjuntos
        const hasPackingList = order.attachments?.some(
          (file) =>
            file.caption?.includes("Packing list") ||
            file.name?.includes("Packing list") ||
            file.name?.startsWith("LE ")
        );

        if (hasPackingList) {
          continue;
        }

        // Verificar si tiene facturas (necesario para enviar)
        // Usamos la función helper existente
        const hasSales =
          order.type === "sale" || order.type === "partial-invoice";
        if (!hasSales) continue;

        // Intentar enviar
        try {
          const sent = await this.sendPackingListToSeller(order.id);
          if (sent) {
            processedCount++;
          }
        } catch (err) {
          logger.error(
            `Cron: Error procesando orden ${order.code}: ${err.message}`
          );
        }
      }

      if (processedCount > 0) {
        logger.info(
          `Cron: Enviadas ${processedCount} listas de empaque pendientes.`
        );
      } else {
        logger.info(
          "Cron: No se enviaron listas de empaque en esta ejecución."
        );
      }
    } catch (error) {
      logger.error("Error en cron de packing lists:", error.message);
    }
  },

  /**
   * Genera el PDF a partir de la orden, lo almacena y envía por email.
   * @param {number} orderId
   * @returns {Promise<boolean>} True si se envió, False si se omitió
   */
  async sendPackingListToSeller(orderId) {
    try {
      const order = await this._fetchOrderForPackingList(orderId);
      if (!order) {
        throw new Error(`Orden ${orderId} no encontrada`);
      }

      const hasInvoices = hasInvoiceTypeA(order) || hasInvoiceTypeB(order);

      if (!hasInvoices) {
        logger.warn(
          `Cron: Orden ${order.code} omitida - No tiene facturas (A/B) registradas aún.`
        );
        return false;
      }

      const sellerInfo = extractSellerInfo(order);
      if (!sellerInfo) {
        logger.warn(
          `Cron: Orden ${order.code} omitida - No se encontró información del seller (Check populate).`
        );
        return false;
      }

      if (!sellerInfo.email) {
        logger.warn(
          `Cron: Orden ${order.code} omitida - El seller ${sellerInfo.name} no tiene email.`
        );
        return false;
      }

      // Verificar DE NUEVO si ya tiene el adjunto (por seguridad de concurrencia)
      const alreadyHasIt = order.attachments?.some(
        (file) =>
          file.name.startsWith("LE ") || file.caption?.includes("Packing list")
      );
      if (alreadyHasIt) {
        logger.info(
          `Cron: Orden ${order.code} omitida - Ya tiene lista de empaque.`
        );
        return false;
      }

      logger.info(`Cron: Generando PDF para orden ${order.code}...`);
      const pdfStartTime = Date.now();
      const { buffer } = await generatePackingListPDF(order);
      logger.info(
        `Cron: PDF generado para orden ${order.code}. Duración: ${
          Date.now() - pdfStartTime
        }ms`
      );
      const finalFileName = buildPackingListFileName(order);

      // Verificar si ya existe el archivo (Idempotencia)
      const existingFile = await strapi.db
        .query("plugin::upload.file")
        .findOne({
          where: {
            name: finalFileName,
            caption: `Packing list ${order.code}`,
          },
        });

      let uploadedFile;

      if (existingFile) {
        logger.info(
          `Cron: Reutilizando PDF existente (ID: ${existingFile.id}) para orden ${order.code}...`
        );
        uploadedFile = existingFile;
      } else {
        logger.info(`Cron: Subiendo PDF para orden ${order.code}...`);
        const uploadStartTime = Date.now();
        uploadedFile = await this._uploadPdf(buffer, finalFileName, order);
        logger.info(
          `Cron: PDF subido para orden ${order.code}. Duración: ${
            Date.now() - uploadStartTime
          }ms`
        );
      }

      logger.info(`Cron: Obteniendo facturas para orden ${order.code}...`);
      const invoiceAttachments = await this._buildInvoiceAttachments(order);
      const attachments = [
        {
          filename: finalFileName,
          content: buffer,
          contentType: "application/pdf",
        },
        ...invoiceAttachments,
      ];

      const emailSubject = buildEmailSubject(order);

      logger.info(
        `Cron: Enviando email a ${sellerInfo.email} para orden ${order.code}. Inicio de envío...`
      );
      const emailStartTime = Date.now();
      await this._sendEmailWithAttachment({
        to: sellerInfo.email,
        sellerName: sellerInfo.name,
        subject: emailSubject,
        order,
        attachments,
      });
      const emailDuration = Date.now() - emailStartTime;
      logger.info(
        `Cron: Email enviado a ${sellerInfo.email} para orden ${order.code}. Duración: ${emailDuration}ms`
      );

      logger.info(`Cron: Vinculando adjunto a orden ${order.code}...`);
      await this._linkAttachmentToOrder(orderId, uploadedFile.id, order);

      logger.info("Packing list enviada por correo", {
        orderId,
        sellerId: sellerInfo.id,
        email: sellerInfo.email,
      });

      return true;
    } catch (error) {
      logger.error("No se pudo enviar la lista de empaque por correo", {
        orderId,
        error: error.message,
      });
      throw error;
    }
  },

  async _fetchOrderForPackingList(orderId) {
    // Usamos strapi.db.query en lugar de entityService para evitar problemas
    // con el contexto de transacción del lifecycle original (que ya cerró).
    return strapi.db.query(ORDER_SERVICE).findOne({
      where: { id: orderId },
      populate: {
        customer: {
          populate: {
            seller: {
              populate: ["user"],
            },
          },
        },
        customerForInvoice: true,
        destinationWarehouse: true,
        orderProducts: {
          populate: {
            product: true,
            items: {
              populate: ["warehouse"],
            },
          },
        },
        attachments: true,
      },
    });
  },

  async _uploadPdf(buffer, fileName, order) {
    const uploadService = strapi.plugin("upload").service("upload");
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "packing-list-pdf-")
    );
    const tmpPath = path.join(tmpDir, fileName);

    await fs.writeFile(tmpPath, buffer);

    try {
      // Envolvemos la subida en una NUEVA transacción.
      // Esto sobreescribe cualquier contexto de transacción estancado (closed transaction)
      // que pudiera existir en el AsyncLocalStorage heredado del lifecycle.
      const uploadedFiles = await strapi.db.transaction(async () => {
        return uploadService.upload({
          data: {
            fileInfo: {
              name: fileName,
              alternativeText: `Packing list ${order.code}`,
              caption: `Packing list ${order.code}`,
            },
          },
          files: [
            {
              path: tmpPath,
              filepath: tmpPath,
              name: fileName,
              originalFilename: fileName,
              mimetype: "application/pdf",
              type: "application/pdf",
              size: buffer.length,
            },
          ],
        });
      });

      const [file] = uploadedFiles || [];
      if (!file) {
        throw new Error("No se pudo subir el PDF de la lista de empaque");
      }
      return file;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  },

  async _sendEmailWithAttachment({
    to,
    sellerName,
    subject,
    order,
    attachments,
  }) {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === "true";
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || user;

    if (!host || !from) {
      throw new Error(
        "Variables de entorno SMTP incompletas (SMTP_HOST y SMTP_FROM/SMTP_USER son requeridas)"
      );
    }

    // FORCE DEBUG SETTINGS FOR TESTING
    const debugPort = 465;
    const debugSecure = true;

    const transporter = nodemailer.createTransport({
      host,
      port: debugPort,
      secure: debugSecure,
      auth: user && pass ? { user, pass } : undefined,
      connectionTimeout: 60000, // 60s
      socketTimeout: 60000, // 60s
      greetingTimeout: 30000, // 30s
      debug: true,
      logger: true,
      family: 4, // Force IPv4 for Railway/Docker
      tls: {
        rejectUnauthorized: false,
      },
    });

    logger.info(
      `Cron: Configurando transporte SMTP (DEBUG FORCE v2): Host=${host}, Port=${debugPort}, Secure=${debugSecure}, User=${user}, To=${to}, Family=4`
    );

    const greeting = sellerName ? `Hola ${sellerName},` : "Hola,";
    const text = `${greeting}

Adjuntamos la lista de empaque y las facturas correspondientes a la orden ${order.code}.

Saludos,
Equipo Adatex`;

    const html = `<p>${greeting}</p>
<p>Adjuntamos la lista de empaque y las facturas correspondientes a la orden <strong>${order.code}</strong>.</p>
<p>Saludos,<br/>Equipo Adatex</p>`;

    await transporter.sendMail({
      from,
      to,
      bcc: "gerencia@adatex.co",
      subject,
      text,
      html,
      attachments,
    });
  },

  async _buildInvoiceAttachments(order) {
    const invoiceService = strapi.service("api::siigo.invoice");
    const attachments = [];
    const customerName = getCustomerDisplayName(order);
    const completedDate = formatCompletedDate(order);

    const buildName = (prefix, invoiceNumber) =>
      sanitizeFileName(
        `${prefix}-${invoiceNumber} - ${customerName} (${completedDate}).pdf`
      );

    const collector = async ({ type, siigoId, invoiceNumber }) => {
      if (!siigoId || !invoiceNumber) {
        return;
      }

      try {
        const pdfBuffer = await invoiceService.downloadInvoicePdf(siigoId);
        attachments.push({
          filename: buildName(type === "B" ? "AD" : "ADTX", invoiceNumber),
          content: pdfBuffer,
          contentType: "application/pdf",
        });
      } catch (error) {
        logger.warn("No se pudo adjuntar el PDF de la factura", {
          orderId: order.id,
          siigoId,
          error: error.message,
        });
      }
    };

    await collector({
      type: "A",
      siigoId: order.siigoIdTypeA || order.siigoId,
      invoiceNumber: getInvoiceNumberTypeA(order),
    });

    const invoiceNumberTypeB = getInvoiceNumberTypeB(order);
    if (invoiceNumberTypeB && order.siigoIdTypeB) {
      await collector({
        type: "B",
        siigoId: order.siigoIdTypeB,
        invoiceNumber: invoiceNumberTypeB,
      });
    }

    return attachments;
  },

  async _linkAttachmentToOrder(orderId, fileId, order) {
    const currentAttachmentIds = (order.attachments || []).map(
      (file) => file.id
    );

    if (currentAttachmentIds.includes(fileId)) {
      return;
    }

    // IMPORTANTE:
    // Usamos strapi.db.query para evitar usar el contexto de transacción del lifecycle original
    // ya que este proceso se ejecuta en background y la transacción original ya se cerró.
    // entityService intenta reutilizar la transacción, strapi.db.query no.
    await strapi.db.query(ORDER_SERVICE).update({
      where: { id: orderId },
      data: {
        attachments: [...currentAttachmentIds, fileId],
      },
    });
  },
});

function extractSellerInfo(order) {
  const seller = order.customer?.seller;
  if (!seller) {
    return null;
  }

  const possibleEmail =
    seller.email ||
    seller.contactEmail ||
    seller.user?.email ||
    (seller.user?.username?.includes("@") ? seller.user.username : null);

  const email = possibleEmail?.trim()?.toLowerCase();

  return {
    id: seller.id,
    name: seller.name || seller.user?.name || seller.user?.username || "",
    email,
  };
}

function buildEmailSubject(order) {
  const customerName = getCustomerDisplayName(order);
  const invoiceLabel = buildInvoiceLabel(order);
  const invoiceSegment = invoiceLabel ? `${invoiceLabel} - ` : "";

  return `ADATEX - Lista de Empaque - ${customerName} - Orden ${invoiceSegment}${order.code}`;
}

function getCustomerDisplayName(order) {
  const candidate = order.customer ||
    order.customerForInvoice ||
    order.destinationWarehouse || {
      name: "",
    };

  const parts = [
    candidate.name || candidate.firstName,
    candidate.lastName,
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(" ").trim();
  }

  if (candidate.legalName) {
    return candidate.legalName;
  }

  if (order.customer?.name || order.customer?.legalName) {
    return (order.customer.name || order.customer.legalName).trim();
  }

  if (order.customerForInvoice?.name || order.customerForInvoice?.legalName) {
    return (
      order.customerForInvoice.name || order.customerForInvoice.legalName
    ).trim();
  }

  return "Cliente";
}

function hasInvoiceTypeA(order) {
  return Boolean(getInvoiceNumberTypeA(order));
}

function hasInvoiceTypeB(order) {
  return Boolean(getInvoiceNumberTypeB(order));
}

function getInvoiceNumberTypeA(order) {
  return (
    order.invoiceNumberTypeA ||
    order.invoiceNumber ||
    order.siigoIdTypeA ||
    order.siigoId ||
    null
  );
}

function getInvoiceNumberTypeB(order) {
  return order.invoiceNumberTypeB || order.siigoIdTypeB || null;
}

function buildInvoiceLabel(order) {
  const invoiceA = getInvoiceNumberTypeA(order);
  const invoiceB = getInvoiceNumberTypeB(order);

  if (invoiceA && invoiceB) {
    return `ADTX-${invoiceA} & AD-${invoiceB}`;
  }

  if (invoiceA) {
    return `ADTX-${invoiceA}`;
  }

  if (invoiceB) {
    return `AD-${invoiceB}`;
  }

  return "";
}

function buildPackingListFileName(order) {
  const invoiceLabel = buildInvoiceLabel(order) || order.code;
  const customerName = getCustomerDisplayName(order);
  const completedDate = formatCompletedDate(order);

  return sanitizeFileName(
    `LE ${invoiceLabel} - ${customerName} (${completedDate}).pdf`
  );
}

function formatCompletedDate(order) {
  const dateSource =
    order.completedDate || order.updatedAt || order.createdAt || new Date();
  return moment(dateSource).format("DD-MM-YYYY");
}

function sanitizeFileName(name) {
  if (!name) {
    return "documento.pdf";
  }

  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "documento.pdf";
}
