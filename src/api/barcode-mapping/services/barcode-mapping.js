"use strict";

const { validateFields } = require("../../../utils/validateRequiredFields");

/**
 * barcode-mapping service
 */

const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService("api::barcode-mapping.barcode-mapping");
