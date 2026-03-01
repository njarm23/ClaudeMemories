export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  IMAGES: R2Bucket;
  FILES: R2Bucket;
  JOBS: Queue<QueueJob>;
  MODEL_KV: KVNamespace;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  AUTH_PASSWORD: string;
  JWT_SECRET: string;
}

// --- Queue Job Types ---

export type WorkerPersona = "stream" | "cron" | "d1" | "gateway";

export interface GossipJob {
  type: "gossip";
  persona: WorkerPersona;
  message: string;
  eventType?: string;
  conversationId?: string;
}

export interface SummarizeConversationJob {
  type: "summarize_conversation";
  conversationId: string;
}

export interface SummarizeBatchJob {
  type: "summarize_batch";
}

export interface WaterCoolerJob {
  type: "water_cooler";
}

export interface ExportConversationJob {
  type: "export_conversation";
  conversationId: string;
  format: "markdown" | "json";
}

export interface WikiSnapshotJob {
  type: "wiki_snapshot";
  pageId: string;
  title: string;
  content: string;
  editedAt: string;
}

export interface DatabaseBackupJob {
  type: "database_backup";
}

export interface ArchiveBatchJob {
  type: "archive_batch";
}

export interface ArchiveConversationJob {
  type: "archive_conversation";
  conversationId: string;
}

export type QueueJob =
  | GossipJob
  | SummarizeConversationJob
  | SummarizeBatchJob
  | WaterCoolerJob
  | ExportConversationJob
  | WikiSnapshotJob
  | DatabaseBackupJob
  | ArchiveBatchJob
  | ArchiveConversationJob;
