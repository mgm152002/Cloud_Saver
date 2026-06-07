# Cloud Saver

Cloud cost optimization platform that scans your AWS infrastructure and provides AI-powered recommendations to reduce spending.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Frontend (Next.js 16)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   Login/     │  │  Dashboard   │  │ Organization │  │ Cloud Account│    │
│  │   Signup     │  │              │  │   Manager    │  │   Scanner    │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API Routes (Next.js)                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   /api/auth  │  │  /api/org    │  │  /api/       │  │  /api/       │    │
│  │   /*         │  │              │  │  cloud-accts │  │  connect/aws │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Backend Services                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │   Better Auth    │  │   Drizzle ORM    │  │   Trigger.dev    │          │
│  │   (Auth)         │  │   (Database)     │  │   (Background)   │          │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            External Services                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │  Supabase    │  │     AWS      │  │  OpenRouter  │  │  CloudWatch  │    │
│  │  (Postgres)  │  │   (STS/EC2)  │  │   (AI LLM)   │  │   (Metrics)  │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| UI | Material UI (MUI) v9 |
| Authentication | Better Auth |
| Database | PostgreSQL (Supabase) |
| ORM | Drizzle ORM |
| Background Jobs | Trigger.dev |
| AI Recommendations | OpenRouter (GPT-4o-mini) |
| Cloud Integration | AWS SDK v3 |

## Database Schema

```
┌─────────────┐       ┌──────────────────┐       ┌──────────────────┐
│    User      │       │   Organization   │       │  Cloud Account   │
│─────────────│       │──────────────────│       │──────────────────│
│ id           │──┐    │ id               │──┐    │ id               │
│ name         │  │    │ name             │  │    │ provider         │
│ email        │  │    │ plan             │  │    │ accountName      │
│ password     │  └───▶│ ownerId          │  └───▶│ status           │
└─────────────┘       └──────────────────┘       │ credentials      │
                                                  └──────────────────┘
                                                         │
                                                         ▼
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│   Scan Job       │       │  Cloud Resource  │       │ AI Recommendation│
│──────────────────│       │──────────────────│       │──────────────────│
│ id               │◀──────│ id               │──────▶│ id               │
│ status           │       │ resourceId       │       │ title            │
│ resourcesFound   │       │ resourceType     │       │ recommendation   │
│ scanMetadata     │       │ monthlyCost      │       │ estimatedSavings │
└──────────────────┘       │ utilization      │       │ severity         │
                           └──────────────────┘       │ confidence       │
                                                      └──────────────────┘
```

## AWS Resources Scanned

- **EC2**: Instances, volumes, CPU utilization metrics
- **RDS**: Database instances, engine types, storage allocation
- **S3**: Buckets, creation dates
- **Lambda**: Functions, runtimes, memory configuration
- **ELB**: Load balancers, type, scheme

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL database (or Supabase account)
- AWS account with programmatic access
- OpenRouter API key

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/mgm152002/Cloud_Saver.git
   cd Cloud_Saver/cloudsaver_frontend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env.local
   ```
   
   Edit `.env.local` with your credentials:
   - `DATABASE_URL`: PostgreSQL connection string
   - `BETTER_AUTH_SECRET`: Random secret for auth (generate with `openssl rand -hex 32`)
   - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`: AWS credentials for cross-account validation
   - `OPENROUTER_API_KEY`: API key for AI recommendations
   - `TRIGGER_SECRET_KEY`: Trigger.dev secret key

4. **Run database migrations**
   ```bash
   npm run db:push
   ```

5. **Start development server**
   ```bash
   npm run dev
   ```

6. **Start Trigger.dev worker** (in a separate terminal)
   ```bash
   npm run trigger:dev
   ```

### Database Management

```bash
# Push schema changes to database
npm run db:push

# Generate migration files
npm run db:generate

# Open Drizzle Studio (database GUI)
npm run db:studio
```

## Project Structure

```
cloudsaver_frontend/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/           # Authentication endpoints
│   │   │   ├── org/            # Organization CRUD
│   │   │   └── connect/aws/    # AWS account connection
│   │   ├── components/         # Shared UI components
│   │   ├── dashboard/          # Main dashboard page
│   │   ├── lib/
│   │   │   ├── auth.ts         # Better Auth server config
│   │   │   ├── auth-client.ts  # Better Auth client
│   │   │   └── aws-onboarding.ts  # AWS credential validation
│   │   ├── login/              # Login page
│   │   ├── org/[orgId]/        # Organization detail pages
│   │   └── signup/             # Signup page
│   ├── components/
│   │   ├── dashboard-layout.tsx # App shell with navigation
│   │   └── theme-registry.tsx   # MUI theme provider
│   └── db/
│       ├── auth-schema.ts      # Drizzle schema definitions
│       └── db.ts               # Database connection
├── trigger/
│   └── aws-initial-scan.ts     # Background job for AWS scanning
├── drizzle/                    # Generated migrations
├── public/                     # Static assets
└── scripts/                    # Utility scripts
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/signup` | Create new user account |
| POST | `/api/auth/login` | Authenticate user |
| GET | `/api/org` | List user's organizations |
| POST | `/api/org` | Create new organization |
| POST | `/api/connect/aws` | Initiate AWS account connection |
| POST | `/api/org/[orgId]/cloud-accounts` | List cloud accounts |

## Background Jobs

The Trigger.dev worker (`aws-initial-scan`) performs:

1. **Credential Validation**: Assumes IAM role with external ID
2. **Multi-Region Scanning**: Iterates through all AWS regions
3. **Resource Discovery**: Collects EC2, RDS, S3, Lambda, ELB resources
4. **Metrics Collection**: Fetches CloudWatch CPU utilization for EC2
5. **AI Analysis**: Sends resource data to OpenRouter for recommendations
6. **Database Update**: Stores resources and recommendations

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Yes | Secret key for auth token signing |
| `BETTER_AUTH_URL` | No | Base URL (default: http://localhost:3000) |
| `AWS_ACCESS_KEY_ID` | Yes | AWS credentials for role validation |
| `AWS_SECRET_ACCESS_KEY` | Yes | AWS credentials for role validation |
| `OPENROUTER_API_KEY` | Yes | API key for AI recommendations |
| `TRIGGER_SECRET_KEY` | No | Trigger.dev secret for background jobs |

## Security

- **No hardcoded credentials**: All secrets are loaded from environment variables
- **External ID validation**: AWS cross-account access uses unique external IDs
- **Session management**: 7-day session expiry with daily refresh
- **Input validation**: All API endpoints validate required fields
- **CORS**: Same-origin policy enforced by default

## Deployment

### Vercel (Recommended)

1. Push code to GitHub
2. Import repository in Vercel
3. Add environment variables in Vercel dashboard
4. Deploy

### Self-Hosted

```bash
# Build for production
npm run build

# Start production server
npm start
```

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## License

This project is private and proprietary.

## Support

For issues and questions, please open a GitHub issue.
