"use strict";

const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService(
  "api::demand-forecast.demand-forecast",
  ({ strapi }) => ({
    /**
     * Calculates demand forecasts per customer × product.
     * Analyzes the last 12 months of orders to determine:
     *  - Average monthly consumption (qty and volume)
     *  - Purchase frequency (avg days between orders for that product)
     *  - Seasonal adjustment (same-month-last-year vs overall average)
     *  - Confidence level (based on data point count)
     */
    async calculateForecasts() {
      const moment = require("moment-timezone");
      const ORDER_TYPES = require("../../../utils/orderTypes");
      const ORDER_STATES = require("../../../utils/orderStates");

      const now = moment();
      const twelveMonthsAgo = moment().subtract(12, "months").startOf("day");
      const currentMonth = now.month(); // 0-indexed
      const currentYear = now.year();

      // Fetch all customers that have had at least one order
      const customers = await strapi.entityService.findMany(
        "api::customer.customer",
        {
          fields: ["id"],
          limit: -1,
        }
      );

      strapi.log.info(
        `[DemandForecast] Starting forecast calculation for ${customers.length} customers...`
      );

      let totalForecasts = 0;

      for (const customer of customers) {
        // Fetch all sale/partial-invoice orders in the last 12 months
        const orders = await strapi.entityService.findMany(
          "api::order.order",
          {
            filters: {
              customer: customer.id,
              type: {
                $in: [ORDER_TYPES.SALE, ORDER_TYPES.PARTIAL_INVOICE],
              },
              state: {
                $in: [ORDER_STATES.COMPLETED, ORDER_STATES.PROCESSING],
              },
              $or: [
                { createdDate: { $gte: twelveMonthsAgo.toDate() } },
                { createdAt: { $gte: twelveMonthsAgo.toDate() } },
                { completedDate: { $gte: twelveMonthsAgo.toDate() } },
              ],
            },
            populate: ["orderProducts", "orderProducts.product"],
          }
        );

        if (!orders || orders.length === 0) continue;

        // --- Group by product ---
        // productData[productId] = { product, orderDates[], monthlyBuckets: { "2025-03": { qty, vol } }, totalQty, totalVol }
        const productData = {};

        for (const order of orders) {
          const dateInput =
            order.createdDate || order.completedDate || order.createdAt;
          const orderDate = moment(dateInput);

          for (const op of order.orderProducts || []) {
            if (!op.product) continue;

            const pId = op.product.id;
            const qty = op.requestedQuantity || 0;
            const price = op.price || 0;
            const lineVol = qty * price;

            if (!productData[pId]) {
              productData[pId] = {
                product: op.product,
                orderDates: [],
                monthlyBuckets: {},
                totalQty: 0,
                totalVol: 0,
              };
            }

            productData[pId].orderDates.push(orderDate.toDate());

            // Bucket by month key "YYYY-MM"
            const monthKey = orderDate.format("YYYY-MM");
            if (!productData[pId].monthlyBuckets[monthKey]) {
              productData[pId].monthlyBuckets[monthKey] = { qty: 0, vol: 0 };
            }
            productData[pId].monthlyBuckets[monthKey].qty += qty;
            productData[pId].monthlyBuckets[monthKey].vol += lineVol;

            productData[pId].totalQty += qty;
            productData[pId].totalVol += lineVol;
          }
        }

        // --- Calculate forecast for each product ---
        for (const [productId, data] of Object.entries(productData)) {
          const { product, orderDates, monthlyBuckets, totalQty, totalVol } =
            data;

          // 1. Count months with data (for averaging)
          const monthKeys = Object.keys(monthlyBuckets);
          const monthsWithData = monthKeys.length;
          if (monthsWithData === 0) continue;

          // 2. Average monthly consumption
          const avgMonthlyQty = totalQty / monthsWithData;
          const avgMonthlyVolume = totalVol / monthsWithData;

          // 3. Seasonal factor: compare same-month-last-year to overall average
          let seasonalFactor = 1.0;
          const sameMonthLastYearKey = moment()
            .subtract(1, "year")
            .format("YYYY-MM");
          const sameMonthData = monthlyBuckets[sameMonthLastYearKey];

          if (sameMonthData && avgMonthlyQty > 0) {
            seasonalFactor = sameMonthData.qty / avgMonthlyQty;
            // Cap extreme seasonality
            if (seasonalFactor > 3) seasonalFactor = 3;
            if (seasonalFactor < 0.2) seasonalFactor = 0.2;
          }

          // 4. Forecasted qty and volume
          const forecastQty = Math.round(avgMonthlyQty * seasonalFactor * 100) / 100;
          const forecastVolume = Math.round(avgMonthlyVolume * seasonalFactor);

          // 5. Purchase frequency (average days between orders for this product)
          const sortedDates = orderDates
            .map((d) => moment(d))
            .sort((a, b) => a.diff(b));

          let purchaseFrequencyDays = 30; // default
          if (sortedDates.length >= 2) {
            let totalGap = 0;
            for (let i = 1; i < sortedDates.length; i++) {
              totalGap += sortedDates[i].diff(sortedDates[i - 1], "days");
            }
            purchaseFrequencyDays = Math.round(
              totalGap / (sortedDates.length - 1)
            );
            if (purchaseFrequencyDays < 1) purchaseFrequencyDays = 1;
          }

          // 6. Next expected purchase date
          const lastOrderDate = sortedDates[sortedDates.length - 1].toDate();
          const nextExpectedPurchaseDate = moment(lastOrderDate)
            .add(purchaseFrequencyDays, "days")
            .format("YYYY-MM-DD");

          // 7. Confidence
          let confidence = "low";
          if (monthsWithData >= 6) confidence = "high";
          else if (monthsWithData >= 3) confidence = "medium";

          // 8. Upsert: check if record exists for this customer × product
          const existing = await strapi.db
            .query("api::demand-forecast.demand-forecast")
            .findOne({
              where: {
                customer: customer.id,
                product: Number(productId),
              },
            });

          const forecastData = {
            customer: customer.id,
            product: Number(productId),
            avgMonthlyQty,
            avgMonthlyVolume: Math.round(avgMonthlyVolume),
            forecastQty,
            forecastVolume,
            purchaseFrequencyDays,
            nextExpectedPurchaseDate,
            confidence,
            lastOrderDate,
            calculatedAt: now.toDate(),
          };

          if (existing) {
            await strapi.db
              .query("api::demand-forecast.demand-forecast")
              .update({
                where: { id: existing.id },
                data: forecastData,
              });
          } else {
            await strapi.db
              .query("api::demand-forecast.demand-forecast")
              .create({
                data: forecastData,
              });
          }

          totalForecasts++;
        }
      }

      strapi.log.info(
        `[DemandForecast] Completed. ${totalForecasts} forecasts created/updated.`
      );
    },

    /**
     * Returns purchase suggestions: forecasts aggregated by product.
     * Sums all customers' forecastQty for each product and compares to current stock.
     */
    async getPurchaseSuggestions() {
      const forecasts = await strapi.db
        .query("api::demand-forecast.demand-forecast")
        .findMany({
          populate: ["product", "customer"],
        });

      // Aggregate by product
      const productMap = {};

      for (const f of forecasts) {
        if (!f.product) continue;
        const pId = f.product.id;

        if (!productMap[pId]) {
          productMap[pId] = {
            product: {
              id: f.product.id,
              name: f.product.name,
              code: f.product.code,
              unit: f.product.unit,
              category: f.product.category,
            },
            totalForecastQty: 0,
            totalForecastVolume: 0,
            customerCount: 0,
            avgConfidence: [],
          };
        }

        productMap[pId].totalForecastQty += Number(f.forecastQty) || 0;
        productMap[pId].totalForecastVolume += Number(f.forecastVolume) || 0;
        productMap[pId].customerCount += 1;
        productMap[pId].avgConfidence.push(f.confidence);
      }

      // Get current stock for each product
      const suggestions = [];

      for (const [productId, data] of Object.entries(productMap)) {
        // Get current stock from items
        const items = await strapi.entityService.findMany("api::item.item", {
          filters: {
            product: productId,
            state: { $in: ["available", "reserved"] },
          },
          fields: ["currentQuantity"],
        });

        const currentStock = items.reduce(
          (sum, item) => sum + (Number(item.currentQuantity) || 0),
          0
        );

        const deficit = data.totalForecastQty - currentStock;

        // Confidence: majority vote
        const confCounts = { high: 0, medium: 0, low: 0 };
        for (const c of data.avgConfidence) confCounts[c]++;
        let dominantConfidence = "low";
        if (confCounts.high >= confCounts.medium && confCounts.high >= confCounts.low)
          dominantConfidence = "high";
        else if (confCounts.medium >= confCounts.low)
          dominantConfidence = "medium";

        let status = "sufficient"; // 🟢
        if (deficit > 0 && currentStock > data.totalForecastQty * 0.5)
          status = "order_soon"; // 🟡
        else if (deficit > 0) status = "deficit"; // 🔴

        suggestions.push({
          ...data.product,
          totalForecastQty: Math.round(data.totalForecastQty * 100) / 100,
          totalForecastVolume: Math.round(data.totalForecastVolume),
          customerCount: data.customerCount,
          currentStock: Math.round(currentStock * 100) / 100,
          deficit: Math.round(deficit * 100) / 100,
          status,
          confidence: dominantConfidence,
        });
      }

      // Sort: deficits first, then by volume descending
      suggestions.sort((a, b) => {
        if (a.status === "deficit" && b.status !== "deficit") return -1;
        if (b.status === "deficit" && a.status !== "deficit") return 1;
        return b.totalForecastVolume - a.totalForecastVolume;
      });

      return suggestions;
    },
  })
);
