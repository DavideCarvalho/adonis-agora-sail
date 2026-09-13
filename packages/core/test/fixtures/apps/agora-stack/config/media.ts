import env from '#start/env'
import { defineConfig, disks, processors, stores, uploadSessions } from '@adonis-agora/media'

/**
 * Storage é delegado ao @adonisjs/drive: `disk` apenas NOMEIA um disk do config/drive.ts.
 *
 * ATUALIZAÇÃO: `disks.s3` (abaixo) agora SOMBREIA o disk 's3' do Drive de propósito — o
 * disco plano do Drive não implementa list/stat/batchDelete, então o library browser do
 * dashboard de media não tinha nenhum disco list-capable pra mostrar. Isso reintroduz a
 * duplicação de credenciais S3 que este comentário originalmente evitava (agora em dois
 * lugares). Se as credenciais mudarem, atualizar os DOIS.
 */
const mediaConfig = defineConfig({
  disk: env.get('DRIVE_DISK'),

  disks: {
    s3: disks.s3({
      credentials: {
        accessKeyId: env.get('AWS_ACCESS_KEY_ID'),
        secretAccessKey: env.get('AWS_SECRET_ACCESS_KEY'),
      },
      region: env.get('AWS_REGION'),
      bucket: env.get('S3_BUCKET'),
      visibility: 'private',
      ...(env.get('USING_MINIO')
        ? {
            endpoint: env.get('MINIO_URL'),
            forcePathStyle: true,
          }
        : {}),
    }),
  },

  // A conexão é explícita porque o app tem mais de uma: o default do driver é a conexão
  // default do Database, que não é a do entretextos.
  store: 'lucid',
  stores: {
    lucid: stores.lucid({ connection: 'entretextos' }),
  },

  imageProcessor: processors.sharp(),

  collections: [
    {
      name: 'avatar',
      single: true,
      acceptsMimeTypes: ['image/png', 'image/jpeg', 'image/gif'],
      conversions: [{ name: 'thumbnail', width: 300, eager: true }],
    },
    {
      name: 'documents',
      single: true,
      acceptsMimeTypes: ['application/pdf', 'text/plain'],
    },
  ],

  uploads: {
    mode: 'auto',
    resumable: {
      store: 'lucid',
      stores: {
        // Mesma conexão explícita do `store` acima.
        lucid: uploadSessions.lucid({ connection: 'entretextos' }),
      },
    },
  },
})

export default mediaConfig
