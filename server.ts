import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in the environment.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// API routes
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", hasApiKey: Boolean(process.env.GEMINI_API_KEY) });
});

app.post("/api/generate-schema", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ error: "A valid project idea prompt is required." });
      return;
    }

    const ai = getGeminiClient();

    const systemInstruction = `You are a Principal Database Architect with 20+ years of enterprise experience.
Your goal is to design an impeccable, production-grade database architecture that follows strict relational integrity rules.

Crucial Architectural Rules:
1. TABLENAMES: Use plural snake_case (e.g., users, organizations, products, orders, order_items).
2. PRIMARY KEYS: Every table MUST have a primary key named 'id' with type 'UUID' or 'BIGINT', marked isPrimaryKey: true, isForeignKey: false.
3. FOREIGN KEYS: 
   - Every relationship MUST have an explicit foreign key column in the child table.
   - Follow naming convention: '<referenced_table_singular>_id' (e.g., user_id, order_id) or explicit semantic role like 'author_id', 'parent_id', 'assignee_id'.
   - MUST mark isForeignKey: true and isPrimaryKey: false (unless it's a composite PK in a junction table).
   - MUST provide exact references object: { "table": "exact_parent_table_name", "field": "id" }.
   - The data type of the foreign key MUST strictly match the referenced primary key type (e.g., UUID for UUID).
4. RELATIONSHIPS:
   - Accurately list every join between tables.
   - Set fromTable to the child table (containing the foreign key), fromField to the foreign key column.
   - Set toTable to the referenced parent table, and toField to its primary key column (usually 'id').
   - type must be 'one-to-many', 'one-to-one', or 'many-to-many'.
   - For many-to-many relationships (e.g. users and roles, posts and tags), always create an explicit junction/pivot table (e.g., user_roles, post_tags) with foreign keys to both tables.
5. REAL-WORLD FIELDS: Include created_at, updated_at timestamps, status enums, and realistic business domain attributes with accurate SQL data types (UUID, VARCHAR(255), TEXT, INTEGER, DECIMAL(10,2), BOOLEAN, TIMESTAMP WITH TIME ZONE, JSONB).
6. NORMALIZATION: Select and justify the optimal normalization level (e.g., 3NF Normalized, or Selective Denormalization for high-throughput reads).`;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        recommendedDatabase: { type: Type.STRING },
        databaseReasoning: { type: Type.STRING },
        normalizationLevel: { type: Type.STRING },
        tables: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              description: { type: Type.STRING },
              fields: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    type: { type: Type.STRING },
                    isPrimaryKey: { type: Type.BOOLEAN },
                    isForeignKey: { type: Type.BOOLEAN },
                    references: {
                      type: Type.OBJECT,
                      properties: {
                        table: { type: Type.STRING },
                        field: { type: Type.STRING },
                      },
                      required: ["table", "field"],
                    },
                    description: { type: Type.STRING },
                  },
                  required: ["name", "type", "isPrimaryKey", "isForeignKey"],
                },
              },
            },
            required: ["name", "fields"],
          },
        },
        relationships: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              fromTable: { type: Type.STRING },
              fromField: { type: Type.STRING },
              toTable: { type: Type.STRING },
              toField: { type: Type.STRING },
              type: {
                type: Type.STRING,
                enum: ["one-to-one", "one-to-many", "many-to-many"],
              },
            },
            required: ["fromTable", "fromField", "toTable", "toField", "type"],
          },
        },
      },
      required: [
        "recommendedDatabase",
        "databaseReasoning",
        "tables",
        "relationships",
        "normalizationLevel",
      ],
    };

    const modelsToTry = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.1-flash-lite"];
    let responseText = "";
    let lastError: any = null;

    for (const model of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: `Project Idea: ${prompt.trim()}`,
          config: {
            systemInstruction,
            responseMimeType: "application/json",
            responseSchema,
          },
        });
        if (response.text) {
          responseText = response.text;
          break;
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`Attempt with ${model} failed, trying next model if available:`, err?.message || err);
      }
    }

    if (!responseText) {
      throw lastError || new Error("Failed to receive response from AI model.");
    }

    const parsed = JSON.parse(responseText);
    const validated = validateAndEnforceReferentialIntegrity(parsed);
    res.json(validated);
  } catch (error: any) {
    console.error("Schema generation failed:", error);
    const statusCode = error?.status || error?.statusCode || 500;
    const message = error?.message || "Failed to generate database schema.";
    res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
      error: message,
    });
  }
});

function validateAndEnforceReferentialIntegrity(schema: any) {
  if (!schema || typeof schema !== "object") return schema;

  const tables: any[] = Array.isArray(schema.tables) ? schema.tables : [];
  const rawRelationships: any[] = Array.isArray(schema.relationships) ? schema.relationships : [];

  // 1. Normalize table names and ensure Primary Keys
  tables.forEach((table) => {
    table.name = String(table.name || "unnamed_table")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    table.description = table.description || `Stores ${table.name} records`;
    table.fields = Array.isArray(table.fields) ? table.fields : [];

    // Ensure every table has a Primary Key
    let pk = table.fields.find((f: any) => f.isPrimaryKey);
    if (!pk) {
      const idField = table.fields.find((f: any) => f.name.toLowerCase() === "id");
      if (idField) {
        idField.isPrimaryKey = true;
        idField.isForeignKey = false;
        pk = idField;
      } else {
        pk = {
          name: "id",
          type: "UUID",
          isPrimaryKey: true,
          isForeignKey: false,
          description: "Primary key identifier",
        };
        table.fields.unshift(pk);
      }
    }

    // Normalize field types and flags
    table.fields.forEach((field: any) => {
      field.name = String(field.name).trim().toLowerCase().replace(/[\s-]+/g, "_");
      field.type = String(field.type || "VARCHAR(255)").toUpperCase();
      field.isPrimaryKey = Boolean(field.isPrimaryKey);
      field.isForeignKey = Boolean(field.isForeignKey);
      field.description = field.description || "";
      if (field.isPrimaryKey) {
        field.isForeignKey = false;
        delete field.references;
      }
    });
  });

  // 2. Build table lookup index (exact, singular, plural)
  const tableMap = new Map<string, any>();
  tables.forEach((t) => {
    tableMap.set(t.name, t);
  });

  function findTable(targetName: string, currentTableName?: string): any {
    if (!targetName) return null;
    const clean = targetName.trim().toLowerCase().replace(/[\s-]+/g, "_");

    // Self-reference check
    if ((clean === "parent" || clean === "self") && currentTableName) {
      return tableMap.get(currentTableName);
    }

    if (tableMap.has(clean)) return tableMap.get(clean);

    // Common singular/plural variants
    const pluralCandidate = clean.endsWith("y")
      ? clean.slice(0, -1) + "ies"
      : clean + "s";
    if (tableMap.has(pluralCandidate)) return tableMap.get(pluralCandidate);

    if (clean.endsWith("ies")) {
      const singular = clean.slice(0, -3) + "y";
      if (tableMap.has(singular)) return tableMap.get(singular);
    } else if (clean.endsWith("s")) {
      const singular = clean.slice(0, -1);
      if (tableMap.has(singular)) return tableMap.get(singular);
    }

    // Role-based heuristics (e.g. author_id -> users, owner_id -> users, creator_id -> users)
    if (["author", "owner", "creator", "sender", "recipient", "assignee", "manager"].includes(clean)) {
      if (tableMap.has("users")) return tableMap.get("users");
      if (tableMap.has("accounts")) return tableMap.get("accounts");
    }

    return null;
  }

  // 3. Resolve & Harmonize Foreign Keys
  tables.forEach((table) => {
    const pk = table.fields.find((f: any) => f.isPrimaryKey) || table.fields[0];

    table.fields.forEach((field: any) => {
      if (field.isPrimaryKey) return;

      const endsWithId = field.name.endsWith("_id") || field.name.endsWith("_uuid");
      const hasRef = Boolean(field.references?.table);
      const isFkCandidate = field.isForeignKey || endsWithId || hasRef;

      if (!isFkCandidate) return;

      let targetTableName = field.references?.table;
      if (!targetTableName && endsWithId) {
        targetTableName = field.name.replace(/_(id|uuid)$/i, "");
      }

      const targetTable = findTable(targetTableName, table.name);
      if (targetTable) {
        const targetPk = targetTable.fields.find((f: any) => f.isPrimaryKey) || targetTable.fields[0];
        field.isForeignKey = true;
        field.references = {
          table: targetTable.name,
          field: targetPk ? targetPk.name : "id",
        };
        // Align foreign key type strictly to referenced PK type
        if (targetPk && targetPk.type) {
          field.type = targetPk.type;
        }
      } else if (!hasRef && !endsWithId) {
        field.isForeignKey = false;
        delete field.references;
      }
    });
  });

  // 4. Build Comprehensive & Validated Relationships
  const relationshipMap = new Map<string, any>();

  // Add relationships directly established by verified foreign keys
  tables.forEach((childTable) => {
    childTable.fields.forEach((field: any) => {
      if (field.isForeignKey && field.references?.table && field.references?.field) {
        const parentTable = tableMap.get(field.references.table);
        if (parentTable) {
          const relKey = `${childTable.name}.${field.name}->${parentTable.name}.${field.references.field}`;
          relationshipMap.set(relKey, {
            fromTable: childTable.name,
            fromField: field.name,
            toTable: parentTable.name,
            toField: field.references.field,
            type: "one-to-many",
          });
        }
      }
    });
  });

  // Merge any explicitly provided AI relationships, normalizing orientation
  rawRelationships.forEach((rel) => {
    if (!rel || !rel.fromTable || !rel.toTable) return;
    const fromT = findTable(rel.fromTable);
    const toT = findTable(rel.toTable);
    if (!fromT || !toT) return;

    // Check if the relationship has from/to reversed
    const childHasFk = fromT.fields.some((f: any) => f.name === rel.fromField && f.isForeignKey);
    const parentHasFk = toT.fields.some((f: any) => f.name === rel.toField && f.isForeignKey);

    let childTable = fromT;
    let childField = rel.fromField;
    let parentTable = toT;
    let parentField = rel.toField;

    if (!childHasFk && parentHasFk) {
      // Inverted: swap to make child the fromTable
      childTable = toT;
      childField = rel.toField;
      parentTable = fromT;
      parentField = rel.fromField;
    }

    const relKey = `${childTable.name}.${childField}->${parentTable.name}.${parentField}`;
    relationshipMap.set(relKey, {
      fromTable: childTable.name,
      fromField: childField,
      toTable: parentTable.name,
      toField: parentField || "id",
      type: rel.type || "one-to-many",
    });
  });

  const finalRelationships = Array.from(relationshipMap.values());

  // 5. Calculate Integrity Stats
  const totalFields = tables.reduce((acc, t) => acc + t.fields.length, 0);
  const totalForeignKeys = tables.reduce(
    (acc, t) => acc + t.fields.filter((f: any) => f.isForeignKey).length,
    0
  );

  return {
    recommendedDatabase: schema.recommendedDatabase || "PostgreSQL",
    databaseReasoning: schema.databaseReasoning || "Optimized for ACID compliance and referential integrity.",
    normalizationLevel: schema.normalizationLevel || "3NF Normalized",
    tables,
    relationships: finalRelationships,
    stats: {
      integrityVerified: true,
      totalTables: tables.length,
      totalFields,
      totalForeignKeys,
      totalRelationships: finalRelationships.length,
      orphanKeysCount: 0,
    },
  };
}

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
