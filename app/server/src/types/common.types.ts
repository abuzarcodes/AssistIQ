/**
 * The authenticated principal attached to `req.user` by the auth middleware.
 * Deliberately minimal — never carries the password hash or other sensitive data.
 */
export interface AuthUser {
  id: string;
  email: string;
}

/** Shape of the signed JWT payload. `sub` is the user id (standard JWT claim). */
export interface JwtPayload {
  sub: string;
  email: string;
}

/** A single FAQ entry handed to the AI service as grounding context. */
export interface AIKnowledgeItem {
  title?: string | null;
  category?: string | null;
  question: string;
  answer: string;
}

/** Input the conversation service passes to the AI service boundary. */
export interface AIRequestInput {
  botId: string;
  conversationId: string;
  message: string;
  knowledge: AIKnowledgeItem[];
}

/**
 * The contract the AI/ML service (mock now, Python/FastAPI later) fulfils.
 * Keeping this stable means swapping mock -> live requires no caller changes (spec §14/§15).
 */
export interface AIResponse {
  answer: string;
  intent?: string;
  confidence?: number;
  shouldEscalate?: boolean;
}
