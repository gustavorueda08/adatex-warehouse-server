const { createStrapi } = require("@strapi/strapi");

async function verifyDashboardStats() {
  const strapi = await createStrapi().load();
  
  try {
    const service = strapi.service("api::dashboard.dashboard");
    const stats = await service.getDashboardStats();
    
    console.log("Dashboard Stats Verification:");
    console.log("-----------------------------");
    
    if (stats.salesChart) {
      console.log("✅ salesChart property exists");
      
      const { weekly, monthly, yearly } = stats.salesChart;
      
      console.log(`\nWeekly Data (${weekly.length} items):`);
      if (weekly.length > 0) {
        console.log("Sample:", weekly[0]);
        console.log("Last:", weekly[weekly.length - 1]);
      } else {
        console.log("⚠️ No weekly data found (might be expected if no sales)");
      }
      
      console.log(`\nMonthly Data (${monthly.length} items):`);
      if (monthly.length > 0) {
        console.log("Sample:", monthly[0]);
        console.log("Last:", monthly[monthly.length - 1]);
      } else {
        console.log("⚠️ No monthly data found");
      }
      
      console.log(`\nYearly Data (${yearly.length} items):`);
      if (yearly.length > 0) {
        console.log("Sample:", yearly[0]);
        console.log("Last:", yearly[yearly.length - 1]);
      } else {
        console.log("⚠️ No yearly data found");
      }
      
    } else {
      console.error("❌ salesChart property MISSING");
    }
    
  } catch (error) {
    console.error("Error verifying stats:", error);
  } finally {
    // strapi.stop() might be needed but usually script exit handles it or it hangs. 
    // For a script, explicit exit is better.
    process.exit(0);
  }
}

verifyDashboardStats();
