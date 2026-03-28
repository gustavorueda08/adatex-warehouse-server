"use strict";

const logger = require("../../../utils/logger");
const { CUSTOMER_SERVICE } = require("../../../utils/services");

/**
 * Servicio de Cuentas por Cobrar de Siigo
 *
 * Usa la cuenta contable 1305 (Clientes nacionales) del endpoint
 * POST /v1/test-balance-report-by-thirdparty, que retorna un Excel con el
 * saldo por tercero (NIT). Las facturas pendientes se obtienen de
 * GET /v1/invoices?customer_identification=X filtrando donde balance > 0.
 */

function currentPeriod() {
  const now = new Date();
  return { year: now.getFullYear(), month_start: 1, month_end: now.getMonth() + 1 };
}

module.exports = ({ strapi }) => ({
  /**
   * Obtiene el balance de cuentas por cobrar de todos los clientes (cuenta 1305).
   * Retorna solo los clientes con saldo_final !== 0, ordenados de mayor a menor.
   */
  async getAccountsReceivable(options = {}) {
    const period = { ...currentPeriod(), ...options };
    const rows = await this._fetchAndParseBalance(period);

    const byNit = new Map();
    for (const row of rows) {
      if (!row.identificacion) continue;
      const key = String(row.identificacion);
      if (!byNit.has(key)) {
        byNit.set(key, { nit: key, nombre: row.nombre_tercero || "", saldo_inicial: 0, debito: 0, credito: 0, saldo_final: 0 });
      }
      const e = byNit.get(key);
      e.saldo_inicial += row.saldo_inicial;
      e.debito += row.debito;
      e.credito += row.credito;
      e.saldo_final += row.saldo_final;
    }

    return Array.from(byNit.values())
      .filter((c) => c.saldo_final !== 0)
      .sort((a, b) => b.saldo_final - a.saldo_final);
  },

  /**
   * Obtiene todas las cuentas por cobrar enriquecidas con datos del vendedor
   * desde la base de datos local de Strapi. Opcionalmente filtra por vendedor.
   */
  async getAccountsReceivableWithSellers(options = {}) {
    const { sellerId, ...periodOpts } = options;
    const arList = await this.getAccountsReceivable(periodOpts);

    // Traer todos los customers con identification y seller
    const customers = await strapi.entityService.findMany(CUSTOMER_SERVICE, {
      fields: ["identification", "name", "lastName"],
      populate: { seller: { fields: ["id", "name"] } },
      pagination: { pageSize: 1000 },
    });

    const nitToCustomer = new Map();
    for (const c of customers) {
      if (c.identification) nitToCustomer.set(String(c.identification), c);
    }

    const enriched = arList.map((item) => {
      const customer = nitToCustomer.get(item.nit);
      const seller = customer?.seller;
      return {
        ...item,
        customerId: customer?.id || null,
        sellerName: seller?.name || "Sin vendedor",
        sellerId: seller?.id || null,
      };
    });

    if (sellerId) {
      return enriched.filter((i) => i.sellerId === parseInt(sellerId));
    }
    return enriched;
  },

  /**
   * Obtiene el balance y las facturas pendientes de UN cliente específico.
   * Usa el NIT (identification) del cliente en Siigo.
   */
  async getCustomerAccountsReceivable(identification, options = {}) {
    const period = { ...currentPeriod(), ...options };

    const [rows, invoices] = await Promise.all([
      this._fetchAndParseBalance({ ...period, identification }),
      this._getUnpaidInvoices(identification),
    ]);

    const balance = rows.reduce(
      (acc, r) => ({
        saldo_inicial: acc.saldo_inicial + r.saldo_inicial,
        debito: acc.debito + r.debito,
        credito: acc.credito + r.credito,
        saldo_final: acc.saldo_final + r.saldo_final,
      }),
      { saldo_inicial: 0, debito: 0, credito: 0, saldo_final: 0 }
    );

    return { identification, balance, period, invoices };
  },

  // ─── Internals ──────────────────────────────────────────────────────────────

  /**
   * Llama a Siigo para generar el reporte Excel de balance por tercero
   * (cuenta 1305), lo descarga y retorna las filas de nivel "Auxiliar".
   * @private
   */
  async _fetchAndParseBalance({ year, month_start, month_end, identification } = {}) {
    const authService = strapi.service("api::siigo.auth");
    const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

    const body = {
      account_start: "1305",
      account_end: "1305",
      year,
      month_start,
      month_end,
      includes_tax_difference: false,
    };

    if (identification) {
      body.customer = { identification: String(identification), branch_office: 0 };
    }

    logger.debug(`[AR] Solicitando balance por tercero año=${year} meses=${month_start}-${month_end}${identification ? " nit=" + identification : ""}`);

    const resp = await authService.authenticatedFetch(
      `${apiUrl}/v1/test-balance-report-by-thirdparty`,
      { method: "POST", body: JSON.stringify(body) }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      // Cliente inactivo en Siigo → sin movimientos contables, devolver vacío
      try {
        const errJson = JSON.parse(errText);
        const isInactive = errJson?.errors?.some((e) => e.code === "parameter_inactive");
        if (isInactive) {
          logger.debug(`[AR] Cliente ${identification} inactivo en Siigo — balance vacío`);
          return [];
        }
      } catch { /* no era JSON válido */ }
      throw new Error(`Siigo balance report error ${resp.status}: ${errText}`);
    }

    const { file_url } = await resp.json();
    if (!file_url) throw new Error("Siigo no retornó URL del archivo Excel");

    const fileResp = await fetch(file_url);
    if (!fileResp.ok) throw new Error(`Error descargando Excel de Azure: ${fileResp.status}`);

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    const XLSX = require("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    const auxiliar = [];
    for (const row of allRows) {
      if (row[0] === "Auxiliar") {
        auxiliar.push({
          identificacion: row[4],
          nombre_tercero: row[6] || "",
          saldo_inicial: typeof row[7] === "number" ? row[7] : 0,
          debito: typeof row[8] === "number" ? row[8] : 0,
          credito: typeof row[9] === "number" ? row[9] : 0,
          saldo_final: typeof row[10] === "number" ? row[10] : 0,
        });
      }
    }

    logger.debug(`[AR] Parseadas ${auxiliar.length} filas de nivel Auxiliar`);
    return auxiliar;
  },

  /**
   * Obtiene todas las facturas con saldo pendiente (balance > 0) de un cliente.
   * Pagina automáticamente la API de Siigo hasta obtener todas.
   * @private
   */
  async _getUnpaidInvoices(identification) {
    const authService = strapi.service("api::siigo.auth");
    const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";
    const invoices = [];
    let page = 1;
    const PAGE_SIZE = 25;

    while (true) {
      const resp = await authService.authenticatedFetch(
        `${apiUrl}/v1/invoices?customer_identification=${identification}&page=${page}&page_size=${PAGE_SIZE}`,
        { method: "GET" }
      );

      if (!resp.ok) break;

      const data = await resp.json();
      const results = data.results || [];

      for (const inv of results) {
        if ((inv.balance || 0) > 0) {
          invoices.push({
            id: inv.id,
            name: inv.name,
            date: inv.date,
            total: inv.total,
            balance: inv.balance,
            due_date: inv.payments?.[0]?.due_date || null,
            public_url: inv.public_url || null,
          });
        }
      }

      const total = data.pagination?.total_results || 0;
      if (page * PAGE_SIZE >= total || results.length === 0) break;
      if (page >= 50) break; // safety: máx 1250 facturas
      page++;
    }

    return invoices.sort((a, b) => new Date(a.date) - new Date(b.date));
  },

  // ─── Helpers de reporte ──────────────────────────────────────────────────────

  _logoPath() {
    return require("path").resolve(__dirname, "../../../assets/logo.png");
  },

  _cop(n) {
    return new Intl.NumberFormat("es-CO", {
      style: "currency", currency: "COP", maximumFractionDigits: 0,
    }).format(n || 0);
  },

  _invoiceStatus(due_date) {
    if (!due_date) return { label: "Sin fecha", overdue: false };
    const days = Math.floor((Date.now() - new Date(due_date).getTime()) / 86400000);
    return days > 0
      ? { label: `Vencida ${days}d`, overdue: true }
      : { label: `Vence en ${-days}d`, overdue: false };
  },

  // ─── Generación de reportes ──────────────────────────────────────────────────

  /**
   * Obtiene cuentas por cobrar con vendedor + facturas pendientes de cada cliente.
   * Las facturas se consultan en lotes paralelos de 5 para respetar el límite de Siigo.
   */
  async getDetailedAccountsReceivable(options = {}) {
    const enriched = await this.getAccountsReceivableWithSellers(options);

    const BATCH = 5;
    for (let i = 0; i < enriched.length; i += BATCH) {
      await Promise.all(
        enriched.slice(i, i + BATCH).map(async (item) => {
          try {
            item.invoices = await this._getUnpaidInvoices(item.nit);
          } catch {
            item.invoices = [];
          }
        })
      );
    }

    return enriched;
  },

  /**
   * Genera un Excel con estilos profesionales (exceljs): logo, colores negro/gris,
   * detalle de facturas por cliente agrupado por vendedor.
   */
  async generateExcelReport(data, meta = {}) {
    const ExcelJS = require("exceljs");
    const fs = require("fs");
    const COP = this._cop.bind(this);
    const statusFn = this._invoiceStatus.bind(this);

    // ── Paleta ───────────────────────────────────────────────────────────────
    const C = {
      dark:        { argb: "FF27272A" },  // zinc-800
      dark2:       { argb: "FF3F3F46" },  // zinc-700
      mid:         { argb: "FF6B6B6B" },
      lightGrey:   { argb: "FFF0F0F0" },
      totalGrey:   { argb: "FFE0E0E0" },
      altRow:      { argb: "FFF9F9F9" },
      white:       { argb: "FFFFFFFF" },
      danger:      { argb: "FFB91C1C" },
      dangerBg:    { argb: "FFFEF2F2" },
      warningBg:   { argb: "FFFEFCE8" },
    };

    const fill = (color) => ({ type: "pattern", pattern: "solid", fgColor: color });
    const border = (style = "thin") => ({
      top: { style }, bottom: { style }, left: { style }, right: { style },
    });
    const thinBorder = border("thin");
    const medBorder = border("medium");

    const wb = new ExcelJS.Workbook();
    wb.creator = "Adatex S.A.S";
    wb.created = new Date();

    const grandTotal = data.reduce((s, i) => s + (i.saldo_final || 0), 0);
    const logoPath = this._logoPath();
    let logoId = null;
    try {
      const logoBuffer = fs.readFileSync(logoPath);
      logoId = wb.addImage({ buffer: logoBuffer, extension: "png" });
    } catch { /* logo opcional */ }

    // ── Función para añadir hoja estilizada ──────────────────────────────────
    const makeSheet = (sheetName, items, sellerName, isResumen) => {
      const ws = wb.addWorksheet(sheetName);

      // Anchos de columna
      ws.columns = isResumen
        ? [{ width: 18 }, { width: 44 }, { width: 28 }, { width: 22 }]
        : [{ width: 44 }, { width: 16 }, { width: 16 }, { width: 22 }, { width: 24 }, { width: 24 }];

      const COLS = isResumen ? 4 : 6;

      // ── Fila 1: Logo + título empresa ───────────────────────────────────
      ws.mergeCells(1, 1, 1, COLS);
      const titleCell = ws.getCell(1, 1);
      titleCell.value = "";
      titleCell.fill = fill(C.dark);
      ws.getRow(1).height = 38;

      if (logoId !== null) {
        ws.addImage(logoId, {
          tl: { col: 0, row: 0 },
          ext: { width: 220, height: 31 },
          editAs: "oneCell",
        });
      }

      // ── Fila 2: Subtítulo ───────────────────────────────────────────────
      ws.mergeCells(2, 1, 2, COLS);
      const sub = ws.getCell(2, 1);
      sub.value = isResumen ? "CUENTAS POR COBRAR — RESUMEN GENERAL" : `CUENTAS POR COBRAR — VENDEDOR: ${sellerName.toUpperCase()}`;
      sub.font = { bold: true, size: 11, color: C.white, name: "Calibri" };
      sub.fill = fill(C.dark2);
      sub.alignment = { vertical: "middle", horizontal: "center" };
      ws.getRow(2).height = 22;

      // ── Fila 3: Período y total ─────────────────────────────────────────
      ws.mergeCells(3, 1, 3, Math.floor(COLS / 2));
      const periodCell = ws.getCell(3, 1);
      periodCell.value = `Período: ${meta.period || "Año en curso"}   |   Generado: ${new Date().toLocaleDateString("es-CO")}`;
      periodCell.font = { size: 9, color: C.dark, italic: true };
      periodCell.fill = fill(C.lightGrey);
      periodCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

      ws.mergeCells(3, Math.floor(COLS / 2) + 1, 3, COLS);
      const totalHeaderCell = ws.getCell(3, Math.floor(COLS / 2) + 1);
      const displayTotal = isResumen ? grandTotal : items.reduce((s, i) => s + (i.saldo_final || 0), 0);
      totalHeaderCell.value = `Total: ${COP(displayTotal)}`;
      totalHeaderCell.font = { bold: true, size: 10, color: C.dark };
      totalHeaderCell.fill = fill(C.lightGrey);
      totalHeaderCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
      ws.getRow(3).height = 18;

      ws.getRow(4).height = 6; // separador

      let rowIdx = 5;

      if (isResumen) {
        // ── Cabecera de tabla ─────────────────────────────────────────────
        const headers = ["NIT", "Cliente", "Vendedor", "Saldo Pendiente"];
        const hRow = ws.getRow(rowIdx++);
        hRow.height = 18;
        headers.forEach((h, i) => {
          const c = hRow.getCell(i + 1);
          c.value = h;
          c.font = { bold: true, size: 9, color: C.white, name: "Calibri" };
          c.fill = fill(C.dark);
          c.alignment = { vertical: "middle", horizontal: i === 3 ? "right" : "left", indent: i < 3 ? 1 : 0 };
          c.border = thinBorder;
        });

        // ── Filas de datos ────────────────────────────────────────────────
        data.forEach((item, idx) => {
          const r = ws.getRow(rowIdx++);
          r.height = 16;
          const rowFill = fill(idx % 2 === 0 ? C.white : C.altRow);
          const vals = [item.nit, item.nombre, item.sellerName || "Sin vendedor", item.saldo_final];
          vals.forEach((v, i) => {
            const c = r.getCell(i + 1);
            c.value = v;
            c.fill = rowFill;
            c.font = { size: 9, color: C.dark };
            c.border = thinBorder;
            if (i === 3) {
              c.numFmt = '"$"#,##0';
              c.alignment = { horizontal: "right" };
              if (v > 0) c.font = { size: 9, bold: true, color: C.danger };
            } else {
              c.alignment = { horizontal: "left", indent: 1 };
            }
          });
        });

        // ── Total ─────────────────────────────────────────────────────────
        const totRow = ws.getRow(rowIdx++);
        totRow.height = 18;
        ws.mergeCells(rowIdx - 1, 1, rowIdx - 1, 3);
        const tc = totRow.getCell(1);
        tc.value = "TOTAL CARTERA";
        tc.font = { bold: true, size: 10, color: C.white };
        tc.fill = fill(C.dark);
        tc.alignment = { horizontal: "right", indent: 1 };
        tc.border = medBorder;
        const tv = totRow.getCell(4);
        tv.value = grandTotal;
        tv.numFmt = '"$"#,##0';
        tv.font = { bold: true, size: 10, color: C.white };
        tv.fill = fill(C.dark);
        tv.alignment = { horizontal: "right" };
        tv.border = medBorder;

      } else {
        // ── Hoja por vendedor: bloques por cliente ─────────────────────
        for (const item of items) {
          const invoices = item.invoices || [];

          // Cliente header
          ws.mergeCells(rowIdx, 1, rowIdx, 4);
          const cName = ws.getCell(rowIdx, 1);
          cName.value = `${item.nombre}   (NIT: ${item.nit})`;
          cName.font = { bold: true, size: 10, color: C.white, name: "Calibri" };
          cName.fill = fill(C.dark2);
          cName.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
          cName.border = thinBorder;

          ws.mergeCells(rowIdx, 5, rowIdx, 6);
          const cSaldo = ws.getCell(rowIdx, 5);
          cSaldo.value = item.saldo_final;
          cSaldo.numFmt = '"$"#,##0';
          cSaldo.font = { bold: true, size: 10, color: C.white };
          cSaldo.fill = fill(C.dark2);
          cSaldo.alignment = { vertical: "middle", horizontal: "right" };
          cSaldo.border = thinBorder;
          ws.getRow(rowIdx).height = 20;
          rowIdx++;

          if (invoices.length === 0) {
            ws.mergeCells(rowIdx, 1, rowIdx, 6);
            const nc = ws.getCell(rowIdx, 1);
            nc.value = "Sin facturas pendientes detalladas.";
            nc.font = { italic: true, size: 8, color: C.mid };
            nc.alignment = { indent: 2 };
            rowIdx++;
          } else {
            // Cabecera facturas
            const invHeaders = ["Factura", "Fecha Emisión", "Vencimiento", "Estado", "Total Factura", "Saldo Pendiente"];
            const ih = ws.getRow(rowIdx++);
            ih.height = 16;
            invHeaders.forEach((h, i) => {
              const c = ih.getCell(i + 1);
              c.value = h;
              c.font = { bold: true, size: 8, color: C.white };
              c.fill = fill(C.dark2);
              c.alignment = { vertical: "middle", horizontal: i >= 4 ? "right" : "left", indent: i < 4 ? 1 : 0 };
              c.border = thinBorder;
            });

            // Filas de facturas
            invoices.forEach((inv, idx) => {
              const { label, overdue } = statusFn(inv.due_date);
              const r = ws.getRow(rowIdx++);
              r.height = 15;
              const bg = overdue ? C.dangerBg : (idx % 2 === 0 ? C.white : C.altRow);
              const vals = [inv.name, inv.date, inv.due_date || "—", label, inv.total, inv.balance];
              vals.forEach((v, i) => {
                const c = r.getCell(i + 1);
                c.value = v;
                c.fill = fill(bg);
                c.border = thinBorder;
                if (i >= 4) {
                  c.numFmt = '"$"#,##0';
                  c.alignment = { horizontal: "right" };
                  c.font = { size: 8, color: i === 5 && overdue ? C.danger : C.dark };
                } else {
                  c.font = { size: 8, color: i === 3 && overdue ? C.danger : C.dark };
                  c.alignment = { horizontal: "left", indent: 1 };
                }
              });
            });

            // Subtotal cliente
            const st = ws.getRow(rowIdx++);
            st.height = 15;
            ws.mergeCells(rowIdx - 1, 1, rowIdx - 1, 4);
            const stL = st.getCell(1);
            stL.value = "Subtotal cliente";
            stL.font = { bold: true, size: 8, color: C.white };
            stL.fill = fill(C.dark);
            stL.alignment = { horizontal: "right", indent: 1 };
            stL.border = thinBorder;
            const stV = st.getCell(6);
            stV.value = invoices.reduce((s, inv) => s + (inv.balance || 0), 0);
            stV.numFmt = '"$"#,##0';
            stV.font = { bold: true, size: 8, color: C.white };
            stV.fill = fill(C.dark);
            stV.alignment = { horizontal: "right" };
            stV.border = thinBorder;
          }

          rowIdx++; // espacio entre clientes
        }

        // Total vendedor
        const sellerTotal = items.reduce((s, i) => s + (i.saldo_final || 0), 0);
        ws.mergeCells(rowIdx, 1, rowIdx, 5);
        const totL = ws.getCell(rowIdx, 1);
        totL.value = "TOTAL VENDEDOR";
        totL.font = { bold: true, size: 10, color: C.white };
        totL.fill = fill(C.dark);
        totL.alignment = { horizontal: "right", indent: 1 };
        totL.border = medBorder;
        const totV = ws.getCell(rowIdx, 6);
        totV.value = sellerTotal;
        totV.numFmt = '"$"#,##0';
        totV.font = { bold: true, size: 10, color: C.white };
        totV.fill = fill(C.dark);
        totV.alignment = { horizontal: "right" };
        totV.border = medBorder;
        ws.getRow(rowIdx).height = 20;
      }

      return ws;
    };

    // ── Hoja resumen ─────────────────────────────────────────────────────────
    makeSheet("Resumen", data, "", true);

    // ── Una hoja por vendedor ─────────────────────────────────────────────────
    const bySeller = new Map();
    for (const item of data) {
      const key = item.sellerName || "Sin vendedor";
      if (!bySeller.has(key)) bySeller.set(key, []);
      bySeller.get(key).push(item);
    }
    for (const [sellerName, items] of bySeller) {
      makeSheet(sellerName.slice(0, 31), items, sellerName, false);
    }

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  },

  /**
   * Genera un PDF con estilos profesionales: logo, header negro, tablas grises.
   * Una portada de resumen + una página por vendedor con facturas por cliente.
   */
  async generatePdfReport(data, meta = {}) {
    const { jsPDF } = require("jspdf");
    const autoTable = require("jspdf-autotable").default || require("jspdf-autotable");
    const fs = require("fs");
    const COP = this._cop.bind(this);
    const statusFn = this._invoiceStatus.bind(this);

    // Paleta
    const DARK      = [39, 39, 42];    // zinc-800
    const DARK2     = [63, 63, 70];    // zinc-700
    const LIGHT     = [240, 240, 240];
    const MID       = [200, 200, 200];
    const WHITE     = [255, 255, 255];
    const DANGER    = [185, 28, 28];
    const DANGER_BG = [254, 242, 242];
    const ALT_ROW   = [249, 249, 249];

    const doc = new jsPDF({ orientation: "landscape", format: "letter" });
    // Landscape letter: 279mm × 216mm. Márgenes: 12mm.
    const PW = 279, PH = 216, M = 12, CW = PW - M * 2;
    const grandTotal = data.reduce((s, i) => s + (i.saldo_final || 0), 0);
    const today = new Date().toLocaleDateString("es-CO");

    // ── Helper: encabezado de página ─────────────────────────────────────────
    const drawPageHeader = (pageTitle, subtitle) => {
      // Barra negra superior
      doc.setFillColor(...DARK);
      doc.rect(0, 0, PW, 18, "F");

      // Logo
      try {
        const logoBuffer = fs.readFileSync(this._logoPath());
        const logoBase64 = logoBuffer.toString("base64");
        doc.addImage(`data:image/png;base64,${logoBase64}`, "PNG", M, 2, 101, 14);
      } catch { /* sin logo */ }

      // Título de página (derecha)
      doc.setTextColor(...WHITE);
      doc.setFontSize(9);
      doc.setFont(undefined, "normal");
      doc.text(pageTitle, PW - M, 8, { align: "right" });
      doc.text(today, PW - M, 14, { align: "right" });

      // Barra gris subtítulo
      doc.setFillColor(...DARK2);
      doc.rect(0, 18, PW, 8, "F");
      doc.setTextColor(...WHITE);
      doc.setFontSize(9);
      doc.setFont(undefined, "bold");
      doc.text(subtitle, M, 23.5);

      if (meta.period) {
        doc.setFont(undefined, "normal");
        doc.setFontSize(8);
        doc.text(`Período: ${meta.period}`, PW - M, 23.5, { align: "right" });
      }

      doc.setTextColor(...DARK);
      return 30; // y después del header
    };

    // ── Portada: resumen general ─────────────────────────────────────────────
    let y = drawPageHeader("CUENTAS POR COBRAR", "RESUMEN GENERAL — TODOS LOS CLIENTES");

    // Tarjeta de total cartera
    doc.setFillColor(...LIGHT);
    doc.roundedRect(M, y, CW, 12, 2, 2, "F");
    doc.setFontSize(9);
    doc.setFont(undefined, "normal");
    doc.setTextColor(...DARK2);
    doc.text("Total Cartera Pendiente:", M + 4, y + 7.5);
    doc.setFontSize(13);
    doc.setFont(undefined, "bold");
    doc.setTextColor(...DARK);
    doc.text(COP(grandTotal), PW - M - 4, y + 7.5, { align: "right" });
    doc.setFont(undefined, "normal");
    y += 17;

    autoTable(doc, {
      startY: y,
      head: [["NIT", "Cliente", "Vendedor", "Saldo Pendiente"]],
      body: [
        ...data.map((i) => [i.nit, i.nombre, i.sellerName || "Sin vendedor", COP(i.saldo_final)]),
        ["", "", "TOTAL", COP(grandTotal)],
      ],
      styles: { fontSize: 8, cellPadding: 2.5, font: "helvetica" },
      headStyles: { fillColor: DARK, textColor: WHITE, fontStyle: "bold", fontSize: 8 },
      alternateRowStyles: { fillColor: ALT_ROW },
      bodyStyles: { textColor: DARK },
      foot: [],
      columnStyles: {
        0: { cellWidth: 26 },
        1: { cellWidth: 100 },
        2: { cellWidth: 55 },
        3: { cellWidth: 40, halign: "right", fontStyle: "bold", textColor: DANGER },
      },
      didParseCell: (hook) => {
        if (hook.row.index === data.length) { // total row
          hook.cell.styles.fillColor = LIGHT;
          hook.cell.styles.fontStyle = "bold";
          hook.cell.styles.textColor = DARK;
        }
      },
      margin: { left: M, right: M },
    });

    // ── Sección por vendedor ─────────────────────────────────────────────────
    const bySeller = new Map();
    for (const item of data) {
      const key = item.sellerName || "Sin vendedor";
      if (!bySeller.has(key)) bySeller.set(key, []);
      bySeller.get(key).push(item);
    }

    for (const [sellerName, items] of bySeller) {
      doc.addPage();
      const sellerTotal = items.reduce((s, i) => s + (i.saldo_final || 0), 0);
      y = drawPageHeader(
        `VENDEDOR: ${sellerName}`,
        `${sellerName.toUpperCase()}  —  ${items.length} cliente(s)  —  Total: ${COP(sellerTotal)}`
      );

      for (const item of items) {
        const invoices = item.invoices || [];
        const neededHeight = invoices.length > 0 ? 10 + invoices.length * 6 + 10 : 20;

        if (y + neededHeight > PH - 10) {
          doc.addPage();
          y = drawPageHeader(`VENDEDOR: ${sellerName} (cont.)`, sellerName.toUpperCase());
        }

        // ── Cabecera de cliente ──────────────────────────────────────────
        doc.setFillColor(...DARK2);
        doc.rect(M, y, CW, 8, "F");
        doc.setFontSize(9);
        doc.setFont(undefined, "bold");
        doc.setTextColor(...WHITE);
        doc.text(`${item.nombre}  ·  NIT: ${item.nit}`, M + 3, y + 5.5);
        doc.text(COP(item.saldo_final), PW - M - 3, y + 5.5, { align: "right" });
        doc.setTextColor(...DARK);
        y += 9;

        if (invoices.length === 0) {
          doc.setFontSize(7.5);
          doc.setFont(undefined, "italic");
          doc.setTextColor(150, 150, 150);
          doc.text("Sin facturas pendientes detalladas.", M + 4, y + 5);
          doc.setTextColor(...DARK);
          y += 10;
        } else {
          autoTable(doc, {
            startY: y,
            head: [["Factura", "Fecha", "Vencimiento", "Estado", "Total Factura", "Saldo Pendiente"]],
            body: invoices.map((inv) => {
              const { label } = statusFn(inv.due_date);
              return [inv.name, inv.date, inv.due_date || "—", label, COP(inv.total), COP(inv.balance)];
            }),
            styles: { fontSize: 7.5, cellPadding: 1.8, font: "helvetica" },
            headStyles: { fillColor: DARK2, textColor: WHITE, fontStyle: "bold", fontSize: 7 },
            alternateRowStyles: { fillColor: ALT_ROW },
            bodyStyles: { textColor: DARK },
            columnStyles: {
              0: { cellWidth: 32 },
              1: { cellWidth: 24 },
              2: { cellWidth: 24 },
              3: { cellWidth: 30 },
              4: { cellWidth: 42, halign: "right" },
              5: { cellWidth: 42, halign: "right", fontStyle: "bold", textColor: DANGER },
            },
            didParseCell: (hook) => {
              const { label, overdue } = statusFn(invoices[hook.row.index]?.due_date);
              if (overdue && hook.row.section === "body") {
                hook.cell.styles.fillColor = DANGER_BG;
                if (hook.column.index === 3 || hook.column.index === 5) {
                  hook.cell.styles.textColor = DANGER;
                }
              }
            },
            margin: { left: M, right: M },
          });
          y = doc.lastAutoTable.finalY + 6;
        }
      }
    }

    // Numeración de páginas
    const totalPages = doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(150, 150, 150);
      doc.text(`Página ${i} de ${totalPages}`, PW - M, PH - 5, { align: "right" });
      doc.text("Adatex S.A.S — Documento confidencial", M, PH - 5);
    }

    return Buffer.from(doc.output("arraybuffer"));
  },

  /**
   * Genera un Excel estilizado con el detalle de cuentas por cobrar de UN cliente.
   */
  async generateCustomerExcelReport(customerData) {
    const ExcelJS = require("exceljs");
    const fs = require("fs");
    const { identification, balance, period, invoices, customerName } = customerData;
    const COP = this._cop.bind(this);
    const statusFn = this._invoiceStatus.bind(this);

    const C = {
      dark:      { argb: "FF27272A" },  // zinc-800
      dark2:     { argb: "FF3F3F46" },  // zinc-700
      light:     { argb: "FFF0F0F0" },
      total:     { argb: "FFE0E0E0" },
      altRow:    { argb: "FFF9F9F9" },
      white:     { argb: "FFFFFFFF" },
      danger:    { argb: "FFB91C1C" },
      dangerBg:  { argb: "FFFEF2F2" },
    };
    const fill = (c) => ({ type: "pattern", pattern: "solid", fgColor: c });
    const thin = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };

    const wb = new ExcelJS.Workbook();
    wb.creator = "Adatex S.A.S";
    const ws = wb.addWorksheet("Cuentas por Cobrar");
    ws.columns = [{ width: 22 }, { width: 16 }, { width: 16 }, { width: 22 }, { width: 22 }];

    const merge = (r, c1, c2, value, style = {}) => {
      ws.mergeCells(r, c1, r, c2);
      const cell = ws.getCell(r, c1);
      cell.value = value;
      Object.assign(cell, style);
      return cell;
    };

    // Fila 1: Header empresa con logo
    ws.getRow(1).height = 36;
    merge(1, 1, 5, "", {
      fill: fill(C.dark),
      alignment: { vertical: "middle", horizontal: "center" },
    });
    try {
      const logoBuffer = fs.readFileSync(this._logoPath());
      const logoId = wb.addImage({ buffer: logoBuffer, extension: "png" });
      ws.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 220, height: 31 }, editAs: "oneCell" });
    } catch { /* sin logo */ }

    // Fila 2: Título
    ws.getRow(2).height = 20;
    merge(2, 1, 5, "ESTADO DE CUENTA — CUENTAS POR COBRAR", {
      font: { bold: true, size: 11, color: C.white },
      fill: fill(C.dark2),
      alignment: { vertical: "middle", horizontal: "center" },
    });

    // Filas 3-4: Info cliente
    ws.getRow(3).height = 17;
    ws.getRow(4).height = 17;
    const infoFill = fill(C.dark2);
    const infoFont = { size: 9, color: C.white };
    merge(3, 1, 3, `Cliente: ${customerName || identification}`, { font: { ...infoFont, bold: true }, fill: infoFill, alignment: { indent: 1 } });
    merge(3, 4, 5, `NIT: ${identification}`, { font: infoFont, fill: infoFill, alignment: { horizontal: "right", indent: 1 } });
    merge(4, 1, 3, `Período: ${period.year}, meses ${period.month_start}–${period.month_end}`, { font: infoFont, fill: infoFill, alignment: { indent: 1 } });
    merge(4, 4, 5, `Generado: ${new Date().toLocaleDateString("es-CO")}`, { font: infoFont, fill: infoFill, alignment: { horizontal: "right", indent: 1 } });

    ws.getRow(5).height = 6; // spacer

    // Fila 6: Cabecera resumen de saldo
    ws.getRow(6).height = 17;
    merge(6, 1, 5, "RESUMEN DE SALDO", {
      font: { bold: true, size: 9, color: C.white },
      fill: fill(C.dark),
      alignment: { vertical: "middle", horizontal: "center" },
    });

    // Fila 7: Labels resumen
    ws.getRow(7).height = 16;
    ["Saldo Inicial", "Débito (Facturas)", "Crédito (Pagos)", "Saldo Pendiente", ""].forEach((h, i) => {
      const c = ws.getCell(7, i + 1);
      c.value = h;
      c.font = { bold: true, size: 8, color: C.white };
      c.fill = fill(C.dark2);
      c.alignment = { horizontal: "right", indent: 1 };
      c.border = thin;
    });

    // Fila 8: Valores resumen
    ws.getRow(8).height = 18;
    [balance.saldo_inicial, balance.debito, balance.credito, balance.saldo_final].forEach((v, i) => {
      const c = ws.getCell(8, i + 1);
      c.value = v;
      c.numFmt = '"$"#,##0';
      c.font = { bold: i === 3, size: 10, color: C.white };
      c.fill = fill(C.dark);
      c.alignment = { horizontal: "right" };
      c.border = thin;
    });

    ws.getRow(9).height = 6;

    // Fila 10: Título facturas
    ws.getRow(10).height = 17;
    merge(10, 1, 5, `FACTURAS PENDIENTES (${invoices.length})`, {
      font: { bold: true, size: 9, color: C.white },
      fill: fill(C.dark),
      alignment: { vertical: "middle", horizontal: "center" },
    });

    // Fila 11: Cabecera facturas
    ws.getRow(11).height = 16;
    ["Factura", "Fecha Emisión", "Vencimiento", "Total Factura", "Saldo Pendiente"].forEach((h, i) => {
      const c = ws.getCell(11, i + 1);
      c.value = h;
      c.font = { bold: true, size: 8, color: C.white };
      c.fill = fill(C.dark2);
      c.alignment = { horizontal: i >= 3 ? "right" : "left", indent: i < 3 ? 1 : 0, vertical: "middle" };
      c.border = thin;
    });

    // Filas de facturas
    let rowIdx = 12;
    if (invoices.length === 0) {
      ws.getRow(rowIdx).height = 14;
      merge(rowIdx, 1, 5, "El cliente está al día — sin facturas pendientes.", {
        font: { italic: true, size: 8, color: { argb: "FF6B6B6B" } },
        alignment: { horizontal: "center" },
      });
    } else {
      invoices.forEach((inv, idx) => {
        const { overdue } = statusFn(inv.due_date);
        const r = ws.getRow(rowIdx++);
        r.height = 15;
        const bg = overdue ? C.dangerBg : (idx % 2 === 0 ? C.white : C.altRow);
        [inv.name, inv.date, inv.due_date || "—", inv.total, inv.balance].forEach((v, i) => {
          const c = r.getCell(i + 1);
          c.value = v;
          c.fill = fill(bg);
          c.border = thin;
          if (i >= 3) {
            c.numFmt = '"$"#,##0';
            c.alignment = { horizontal: "right" };
            c.font = { size: 8, color: i === 4 && overdue ? C.danger : C.dark };
          } else {
            c.font = { size: 8, color: C.dark };
            c.alignment = { horizontal: "left", indent: 1 };
          }
        });
      });

      // Total
      const totRow = ws.getRow(rowIdx);
      totRow.height = 17;
      ws.mergeCells(rowIdx, 1, rowIdx, 3);
      const tl = totRow.getCell(1);
      tl.value = "TOTAL PENDIENTE";
      tl.font = { bold: true, size: 9, color: C.white };
      tl.fill = fill(C.dark);
      tl.alignment = { horizontal: "right", indent: 1 };
      tl.border = thin;
      const tv = totRow.getCell(5);
      tv.value = invoices.reduce((s, i) => s + (i.balance || 0), 0);
      tv.numFmt = '"$"#,##0';
      tv.font = { bold: true, size: 9, color: C.white };
      tv.fill = fill(C.dark);
      tv.alignment = { horizontal: "right" };
      tv.border = thin;
    }

    return Buffer.from(await wb.xlsx.writeBuffer());
  },

  /**
   * Genera un PDF estilizado con el detalle de cuentas por cobrar de UN cliente.
   */
  async generateCustomerPdfReport(customerData) {
    const { jsPDF } = require("jspdf");
    const autoTable = require("jspdf-autotable").default || require("jspdf-autotable");
    const fs = require("fs");
    const { identification, balance, period, invoices, customerName } = customerData;
    const COP = this._cop.bind(this);
    const statusFn = this._invoiceStatus.bind(this);

    const DARK      = [39, 39, 42];    // zinc-800
    const DARK2     = [63, 63, 70];    // zinc-700
    const LIGHT     = [240, 240, 240];
    const MID       = [200, 200, 200];
    const WHITE     = [255, 255, 255];
    const DANGER    = [185, 28, 28];
    const DANGER_BG = [254, 242, 242];
    const ALT_ROW   = [249, 249, 249];

    const doc = new jsPDF({ format: "letter" });
    // Portrait letter: 216mm × 279mm. Márgenes: 12mm.
    const PW = 216, PH = 279, M = 12, CW = PW - M * 2;
    const today = new Date().toLocaleDateString("es-CO");

    // ── Header ───────────────────────────────────────────────────────────────
    doc.setFillColor(...DARK);
    doc.rect(0, 0, PW, 20, "F");

    try {
      const logoBuffer = fs.readFileSync(this._logoPath());
      doc.addImage(`data:image/png;base64,${logoBuffer.toString("base64")}`, "PNG", M, 3, 101, 14);
    } catch { /* sin logo */ }

    doc.setTextColor(...WHITE);
    doc.setFontSize(8);
    doc.setFont(undefined, "normal");
    doc.text(today, PW - M, 11, { align: "right" });

    // ── Banda subtítulo ──────────────────────────────────────────────────────
    doc.setFillColor(...DARK2);
    doc.rect(0, 20, PW, 9, "F");
    doc.setTextColor(...WHITE);
    doc.setFontSize(9);
    doc.setFont(undefined, "bold");
    doc.text("CUENTAS POR COBRAR — FACTURAS PENDIENTES", M, 26);

    // ── Info cliente ─────────────────────────────────────────────────────────
    doc.setFillColor(...DARK2);
    doc.rect(M, 32, CW, 22, "F");
    doc.setTextColor(...WHITE);
    doc.setFontSize(11);
    doc.setFont(undefined, "bold");
    doc.text(customerName || identification, M + 4, 40);
    doc.setFontSize(8.5);
    doc.setFont(undefined, "normal");
    doc.text(`NIT: ${identification}`, M + 4, 47);
    doc.text(`Período: ${period.year}, meses ${period.month_start}–${period.month_end}`, M + 4, 52);

    // ── Resumen de saldo ─────────────────────────────────────────────────────
    doc.setTextColor(...DARK);
    doc.setFontSize(9);
    doc.setFont(undefined, "bold");
    doc.text("Resumen de Saldo", M, 62);

    autoTable(doc, {
      startY: 64,
      head: [["Saldo Inicial", "Débito (Facturas)", "Crédito (Pagos)", "Saldo Pendiente"]],
      body: [[COP(balance.saldo_inicial), COP(balance.debito), COP(balance.credito), COP(balance.saldo_final)]],
      styles: { fontSize: 9, cellPadding: 3, halign: "right" },
      headStyles: { fillColor: DARK, textColor: WHITE, fontStyle: "bold", fontSize: 8 },
      bodyStyles: { textColor: DARK, fillColor: LIGHT },
      columnStyles: {
        3: { fontStyle: "bold", textColor: balance.saldo_final > 0 ? DANGER : DARK },
      },
      margin: { left: M, right: M },
    });

    // ── Facturas ─────────────────────────────────────────────────────────────
    const invStartY = doc.lastAutoTable.finalY + 8;
    doc.setFontSize(9);
    doc.setFont(undefined, "bold");
    doc.setTextColor(...DARK);
    doc.text(`Facturas Pendientes  (${invoices.length})`, M, invStartY);

    if (invoices.length === 0) {
      doc.setFillColor(...LIGHT);
      doc.rect(M, invStartY + 3, CW, 12, "F");
      doc.setFontSize(8.5);
      doc.setFont(undefined, "italic");
      doc.setTextColor(120, 120, 120);
      doc.text("El cliente está al día — sin facturas pendientes.", PW / 2, invStartY + 11, { align: "center" });
    } else {
      autoTable(doc, {
        startY: invStartY + 4,
        head: [["Factura", "Fecha", "Vencimiento", "Estado", "Total", "Saldo Pendiente"]],
        body: invoices.map((inv) => {
          const { label } = statusFn(inv.due_date);
          return [inv.name, inv.date, inv.due_date || "—", label, COP(inv.total), COP(inv.balance)];
        }),
        styles: { fontSize: 8, cellPadding: 2.5, font: "helvetica" },
        headStyles: { fillColor: DARK2, textColor: WHITE, fontStyle: "bold", fontSize: 7.5 },
        alternateRowStyles: { fillColor: ALT_ROW },
        bodyStyles: { textColor: DARK },
        columnStyles: {
          4: { halign: "right" },
          5: { halign: "right", fontStyle: "bold", textColor: DANGER },
        },
        didParseCell: (hook) => {
          const inv = invoices[hook.row.index];
          if (hook.row.section === "body" && inv) {
            const { overdue } = statusFn(inv.due_date);
            if (overdue) {
              hook.cell.styles.fillColor = DANGER_BG;
              if (hook.column.index === 3 || hook.column.index === 5) {
                hook.cell.styles.textColor = DANGER;
              }
            }
          }
        },
        margin: { left: M, right: M },
      });

      // Total pendiente
      const ty = doc.lastAutoTable.finalY;
      doc.setFillColor(...DARK);
      doc.rect(M, ty, CW, 9, "F");
      doc.setFontSize(9);
      doc.setFont(undefined, "bold");
      doc.setTextColor(...WHITE);
      doc.text("Total Pendiente", M + 3, ty + 6);
      const pendTotal = invoices.reduce((s, i) => s + (i.balance || 0), 0);
      doc.text(COP(pendTotal), PW - M - 3, ty + 6, { align: "right" });
    }

    // ── Pie de página ────────────────────────────────────────────────────────
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.setFont(undefined, "normal");
    doc.text("Adatex S.A.S — Documento confidencial", M, PH - 8);
    doc.text(`Generado el ${today}`, PW - M, PH - 8, { align: "right" });

    return Buffer.from(doc.output("arraybuffer"));
  },
});
