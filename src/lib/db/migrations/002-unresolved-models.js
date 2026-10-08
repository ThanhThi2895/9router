// Schema migration #2: add unresolvedModels table for tracking missing model requests
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 2,
  name: "unresolved-models",
  up(db) {
    const def = TABLES.unresolvedModels;
    if (def) {
      db.exec(buildCreateTableSql("unresolvedModels", def));
      for (const idx of def.indexes || []) db.exec(idx);
    }
  },
};
