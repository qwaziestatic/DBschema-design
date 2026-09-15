export interface TableField {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  references?: {
    table: string;
    field: string;
  };
  description: string;
}

export interface Table {
  name: string;
  fields: TableField[];
  description: string;
}

export interface Relationship {
  fromTable: string;
  fromField: string;
  toTable: string;
  toField: string;
  type: "one-to-one" | "one-to-many" | "many-to-many";
}

export interface SchemaValidationStats {
  integrityVerified: boolean;
  totalTables: number;
  totalFields: number;
  totalForeignKeys: number;
  totalRelationships: number;
  orphanKeysCount: number;
}

export interface SchemaResponse {
  recommendedDatabase: string;
  databaseReasoning: string;
  tables: Table[];
  relationships: Relationship[];
  normalizationLevel: string;
  stats?: SchemaValidationStats;
}

export async function generateSchema(prompt: string): Promise<SchemaResponse> {
  const response = await fetch("/api/generate-schema", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });

  if (!response.ok) {
    let errorMessage = `Server error (${response.status})`;
    try {
      const errorData = await response.json();
      if (errorData?.error) {
        errorMessage = errorData.error;
      }
    } catch {
      const text = await response.text();
      if (text) errorMessage = text;
    }
    throw new Error(errorMessage);
  }

  const data: SchemaResponse = await response.json();
  if (!data || !Array.isArray(data.tables)) {
    throw new Error("Invalid schema structure returned by the server.");
  }

  return data;
}
