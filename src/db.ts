import { PrismaClient } from '@prisma/client'

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres.izxodeqeofxkyeluymvz:wp8dZOTICPfYBCBQ@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'
}

export const db = new PrismaClient({
  log: ['error'],
})
