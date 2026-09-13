import env from '#start/env'
import { defineConfig, transports } from '@adonisjs/mail'

const mailConfig = defineConfig({
  default: 'smtp',

  /**
   * Remetente global. O @adonisjs/mail aplica em toda mensagem sem `from` próprio,
   * e o @adonis-agora/authkit-server lê daqui (config.mail.from) o remetente dos
   * e-mails internos dele. Sem isto o envelope MAIL FROM ia vazio e o Resend
   * rejeitava com 550 Invalid from.
   */
  from: env.get('EMAIL_FROM'),

  /**
   * The mailers object can be used to configure multiple mailers
   * each using a different transport or same transport with different
   * options.
   */
  mailers: {
    smtp: transports.smtp({
      host: env.get('SMTP_HOST'),
      port: env.get('SMTP_PORT'),
      // Porta 465 (Resend) usa TLS implícito. Sem `secure: true` o nodemailer
      // assume STARTTLS e a conexão falha calada.
      secure: env.get('SMTP_PORT') === 465,
      auth: {
        user: env.get('SMTP_USER'),
        pass: env.get('SMTP_PASSWORD'),
        type: 'login',
      },
    }),
    resend: transports.resend({
      key: env.get('ENTRETEXTOS_RESEND_API_KEY'),
      baseUrl: 'https://api.resend.com',
    }),
  },
})

export default mailConfig

declare module '@adonisjs/mail/types' {
  export interface MailersList extends InferMailers<typeof mailConfig> {}
}
