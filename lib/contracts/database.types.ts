
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "attempt_grades": {
                  Row: {
                    "attempt_id": string,"created_at": string,"details": NonNullable<Json>,"generation": number,"grader_version": string,"id": string,"model": string,"outcome": string,"passed": boolean | null,"prompt_version": string,"rubric_version": string,"score": number | null,"simulated": boolean,"user_id": string,"validator_version": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_id": string,"created_at"?: string,"details": NonNullable<Json>,"generation": number,"grader_version": string,"id"?: string,"model": string,"outcome": string,"passed"?: boolean | null,"prompt_version": string,"rubric_version": string,"score"?: number | null,"simulated": boolean,"user_id": string,"validator_version": string
                  }
                  Update: {
                    "attempt_id"?: string,"created_at"?: string,"details"?: NonNullable<Json>,"generation"?: number,"grader_version"?: string,"id"?: string,"model"?: string,"outcome"?: string,"passed"?: boolean | null,"prompt_version"?: string,"rubric_version"?: string,"score"?: number | null,"simulated"?: boolean,"user_id"?: string,"validator_version"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "attempt_grades_attempt_id_user_id_fkey"
      columns: ["attempt_id","user_id"]
isOneToOne: false
      referencedRelation: "attempts"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"attempts": {
                  Row: {
                    "active_ms": number,"answer_text": string,"assisted": boolean,"confidence": string,"id": string,"idempotency_key": string,"input_mode": string,"item_id": string,"question_version_id": string,"request_fingerprint": string,"scheduling_jitter": number,"source": string,"submitted_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active_ms": number,"answer_text": string,"assisted": boolean,"confidence": string,"id"?: string,"idempotency_key": string,"input_mode"?: string,"item_id": string,"question_version_id": string,"request_fingerprint": string,"scheduling_jitter"?: number,"source": string,"submitted_at"?: string,"user_id": string
                  }
                  Update: {
                    "active_ms"?: number,"answer_text"?: string,"assisted"?: boolean,"confidence"?: string,"id"?: string,"idempotency_key"?: string,"input_mode"?: string,"item_id"?: string,"question_version_id"?: string,"request_fingerprint"?: string,"scheduling_jitter"?: number,"source"?: string,"submitted_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "attempts_item_id_user_id_question_version_id_fkey"
      columns: ["item_id","user_id","question_version_id"]
isOneToOne: false
      referencedRelation: "session_items"
      referencedColumns: ["id","user_id","question_version_id"]
    }
                  ]
                },"grade_selections": {
                  Row: {
                    "attempt_id": string,"grade_id": string,"id": number,"previous_grade_id": string | null,"reason": string,"selected_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_id": string,"grade_id": string,"id"?: never,"previous_grade_id"?: string | null,"reason": string,"selected_at"?: string,"user_id": string
                  }
                  Update: {
                    "attempt_id"?: string,"grade_id"?: string,"id"?: never,"previous_grade_id"?: string | null,"reason"?: string,"selected_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "grade_selections_grade_id_attempt_id_user_id_fkey"
      columns: ["grade_id","attempt_id","user_id"]
isOneToOne: false
      referencedRelation: "attempt_grades"
      referencedColumns: ["id","attempt_id","user_id"]
    },{
      foreignKeyName: "grade_selections_previous_grade_id_fkey"
      columns: ["previous_grade_id"]
isOneToOne: false
      referencedRelation: "attempt_grades"
      referencedColumns: ["id"]
    }
                  ]
                },"grading_jobs": {
                  Row: {
                    "attempt_id": string,"error_code": string | null,"generation": number,"lease_token": string | null,"lease_until": string | null,"next_attempt_at": string,"repair_used": boolean,"request_count": number,"state": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_id": string,"error_code"?: string | null,"generation"?: number,"lease_token"?: string | null,"lease_until"?: string | null,"next_attempt_at"?: string,"repair_used"?: boolean,"request_count"?: number,"state"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "attempt_id"?: string,"error_code"?: string | null,"generation"?: number,"lease_token"?: string | null,"lease_until"?: string | null,"next_attempt_at"?: string,"repair_used"?: boolean,"request_count"?: number,"state"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "grading_jobs_attempt_id_user_id_fkey"
      columns: ["attempt_id","user_id"]
isOneToOne: false
      referencedRelation: "attempts"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"timezone": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"timezone"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"timezone"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"question_versions": {
                  Row: {
                    "content_blocks": NonNullable<Json>,"content_review": string,"id": string,"prompt_version": string,"question_id": string,"skill": string,"title": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "content_blocks": NonNullable<Json>,"content_review": string,"id": string,"prompt_version": string,"question_id": string,"skill": string,"title": string,"version": number
                  }
                  Update: {
                    "content_blocks"?: NonNullable<Json>,"content_review"?: string,"id"?: string,"prompt_version"?: string,"question_id"?: string,"skill"?: string,"title"?: string,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"review_episodes": {
                  Row: {
                    "first_missed_at": string,"graduated_at": string | null,"id": string,"next_due_at": string | null,"question_id": string,"rules_version": string,"streak": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "first_missed_at": string,"graduated_at"?: string | null,"id": string,"next_due_at"?: string | null,"question_id": string,"rules_version"?: string,"streak": number,"user_id": string
                  }
                  Update: {
                    "first_missed_at"?: string,"graduated_at"?: string | null,"id"?: string,"next_due_at"?: string | null,"question_id"?: string,"rules_version"?: string,"streak"?: number,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "review_episodes_id_fkey"
      columns: ["id"]
isOneToOne: true
      referencedRelation: "attempts"
      referencedColumns: ["id"]
    }
                  ]
                },"session_items": {
                  Row: {
                    "answer_text": string,"assisted": boolean,"confidence": string,"displayed_at": string,"first_interaction_at": string | null,"id": string,"last_ack_at": string | null,"lease_device": string | null,"lease_until": string | null,"paused": boolean,"question_version_id": string,"saved_at": string,"sequence": number,"session_id": string,"source": string,"state": string,"user_id": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "answer_text"?: string,"assisted"?: boolean,"confidence"?: string,"displayed_at"?: string,"first_interaction_at"?: string | null,"id"?: string,"last_ack_at"?: string | null,"lease_device"?: string | null,"lease_until"?: string | null,"paused"?: boolean,"question_version_id": string,"saved_at"?: string,"sequence"?: number,"session_id": string,"source": string,"state"?: string,"user_id": string,"version"?: number
                  }
                  Update: {
                    "answer_text"?: string,"assisted"?: boolean,"confidence"?: string,"displayed_at"?: string,"first_interaction_at"?: string | null,"id"?: string,"last_ack_at"?: string | null,"lease_device"?: string | null,"lease_until"?: string | null,"paused"?: boolean,"question_version_id"?: string,"saved_at"?: string,"sequence"?: number,"session_id"?: string,"source"?: string,"state"?: string,"user_id"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "session_items_question_version_id_fkey"
      columns: ["question_version_id"]
isOneToOne: false
      referencedRelation: "question_versions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "session_items_session_id_user_id_fkey"
      columns: ["session_id","user_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"sessions": {
                  Row: {
                    "id": string,"started_at": string,"state": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: string,"started_at"?: string,"state"?: string,"user_id": string
                  }
                  Update: {
                    "id"?: string,"started_at"?: string,"state"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"timing_segments": {
                  Row: {
                    "ended_at": string,"id": number,"item_id": string,"started_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ended_at": string,"id"?: never,"item_id": string,"started_at": string,"user_id": string
                  }
                  Update: {
                    "ended_at"?: string,"id"?: never,"item_id"?: string,"started_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "timing_segments_item_id_user_id_fkey"
      columns: ["item_id","user_id"]
isOneToOne: false
      referencedRelation: "session_items"
      referencedColumns: ["id","user_id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "checkpoint":
{ Args: { "p_action": string,"p_answer": string,"p_assisted": boolean,"p_confidence": string,"p_device": string,"p_item": string,"p_version": number }; Returns: {
              "answer_text": string,
"assisted": boolean,
"confidence": string,
"displayed_at": string,
"first_interaction_at": string | null,
"id": string,
"last_ack_at": string | null,
"lease_device": string | null,
"lease_until": string | null,
"paused": boolean,
"question_version_id": string,
"saved_at": string,
"sequence": number,
"session_id": string,
"source": string,
"state": string,
"user_id": string,
"version": number
            }
                          SetofOptions: {
        from: "*"
        to: "session_items"
        isOneToOne: true
        isSetofReturn: false
      } },
"claim_grading":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"fail_grading":
{ Args: { "p_attempt": string,"p_error": string,"p_generation": number,"p_lease": string,"p_retry_seconds": number }; Returns: undefined
                           },
"finalize_grade":
{ Args: { "p_attempt": string,"p_generation": number,"p_lease": string,"p_model": string,"p_result": Json,"p_simulated": boolean }; Returns: string
                           },
"reserve_provider_request":
{ Args: { "p_attempt": string,"p_cents": number,"p_daily_cap": number,"p_generation": number,"p_lease": string,"p_monthly_cap": number,"p_repair": boolean }; Returns: string
                           },
"retry_grade":
{ Args: { "p_attempt": string }; Returns: number
                           },
"settle_provider_request":
{ Args: { "p_cents": number,"p_request": string,"p_usage": Json }; Returns: undefined
                           },
"start_study":
{ Args: { "p_question": string,"p_timezone": string }; Returns: string
                           },
"study_state":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"submit_answer":
{ Args: { "p_answer": string,"p_assisted": boolean,"p_confidence": string,"p_device": string,"p_item": string,"p_key": string,"p_question": string,"p_version": number }; Returns: string
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
