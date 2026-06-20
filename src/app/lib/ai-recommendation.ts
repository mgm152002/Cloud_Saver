type AIRecommendation = {
  id: string;

  category:
    | "cost_optimization"
    | "security"
    | "performance"
    | "reliability"
    | "compliance"
    | "cleanup";

  action: string;

  resource: {
    provider: "aws" | "azure" | "gcp" | "kubernetes" | "generic";
    service: string;
    type: string;
    id: string;
    name?: string;
    region?: string;
    accountId?: string;
  };

  currentState?: Record<string, unknown>;

  recommendedState?: Record<string, unknown>;

  impact?: {
    estimatedSavings?: number;
    currency?: string;
    period?: "hourly" | "daily" | "monthly" | "yearly";
    riskLevel?: "low" | "medium" | "high";
    severity?: "info" | "low" | "medium" | "high" | "critical";
  };

  reason: string;

  confidence?: number;

  requiresApproval?: boolean;

  toolHint?: {
    toolName: string;
    operation: string;
    parameters?: Record<string, unknown>;
  };

  metadata?: Record<string, unknown>;
};
