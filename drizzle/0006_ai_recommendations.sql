ALTER TABLE ai_recommendations
ADD COLUMN account_id UUID REFERENCES cloud_accounts(id);