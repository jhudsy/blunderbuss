# Blunderbuss Documentation

This directory contains the detailed documentation for the Blunderbuss chess puzzle trainer.

## Documentation Files

### Getting Started
- **[../README.md](../README.md)** - Quick start guide, development setup, and testing

### Backend & API
- **[BACKEND.md](BACKEND.md)** - Backend routes, API contracts, authentication, and security notes
- **[SCHEMA.md](SCHEMA.md)** - Database schema reference (PonyORM models)
- **[MIGRATIONS.md](MIGRATIONS.md)** - Database migration notes and scripts

### Frontend & User Experience
- **[FRONTEND.md](FRONTEND.md)** - UI requirements, evaluation-based validation, and user interactions
- **[STOCKFISH_INTEGRATION.md](STOCKFISH_INTEGRATION.md)** - Stockfish engine integration, evaluation system, and debugging

### Deployment & Operations
- **[DEPLOYMENT.md](DEPLOYMENT.md)** - Production deployment with Docker, nginx, systemd, and security headers

## Quick Navigation

**For Developers:**
1. Start with [../README.md](../README.md) for local development setup
2. Read [BACKEND.md](BACKEND.md) and [FRONTEND.md](FRONTEND.md) to understand the architecture
3. See [STOCKFISH_INTEGRATION.md](STOCKFISH_INTEGRATION.md) for chess engine details

**For Deployment:**
1. Review [DEPLOYMENT.md](DEPLOYMENT.md) for production setup
2. Check [MIGRATIONS.md](MIGRATIONS.md) for database updates
3. Refer to security headers section in [DEPLOYMENT.md](DEPLOYMENT.md) for CORS/COEP/COOP configuration

**For Database Work:**
1. See [SCHEMA.md](SCHEMA.md) for current schema
2. Check [MIGRATIONS.md](MIGRATIONS.md) for migration scripts

## Key Topics

- **Evaluation-based Move Validation**: See [BACKEND.md](BACKEND.md#getting-puzzles) and [STOCKFISH_INTEGRATION.md](STOCKFISH_INTEGRATION.md)
- **Security Headers (COOP/COEP/CORP)**: See [DEPLOYMENT.md](DEPLOYMENT.md#security-headers-for-cross-origin-isolation-coopeepcorp)
- **OAuth Authentication**: See [BACKEND.md](BACKEND.md#authentication)
- **Spaced Repetition Algorithm**: See [BACKEND.md](BACKEND.md#getting-puzzles)
- **Multiple Attempts Feature**: See [FRONTEND.md](FRONTEND.md#multiple-attempts-feature)
