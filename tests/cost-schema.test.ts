import assert from "node:assert/strict";
import test from "node:test";

import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { costAnomalies, costDailyRecords, costForecasts } from "../src/db/auth-schema";

test("cost records are removed when their cloud account is deleted", () => {
  for (const table of [costDailyRecords, costForecasts, costAnomalies]) {
    const accountReference = getTableConfig(table).foreignKeys.find(
      (foreignKey) => getTableName(foreignKey.reference().foreignTable) === "cloud_accounts",
    );

    assert.ok(accountReference, "expected a cloud account foreign key");
    assert.equal(accountReference.onDelete, "cascade");
  }
});
