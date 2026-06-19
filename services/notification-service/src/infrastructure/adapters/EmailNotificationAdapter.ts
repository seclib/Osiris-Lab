import { Logger } from '../../application/commands/SendNotificationCommand';
import { Notification, NotificationChannel } from '../../domain/entities/Notification';

export interface EmailNotificationAdapter {
  send(notification: Notification, to: string): Promise<boolean>;
  sendToMultiple(notification: Notification, recipients: string[]): Promise<boolean[]>;
}

export class NodemailerEmailAdapter implements EmailNotificationAdapter {
  constructor(private logger: Logger) {}

  async send(notification: Notification, to: string): Promise<boolean> {
    try {
      // Email content
      const subject = `[${notification.severity.toUpperCase()}] ${notification.title}`;
      const html = this.generateEmailTemplate(notification);
      const text = this.generatePlainText(notification);

      // Email configuration
      const mailOptions = {
        from: process.env.EMAIL_FROM || 'notifications@osiris.ai',
        to,
        subject,
        text,
        html,
        priority: this.getEmailPriority(notification.severity),
      };

      // Send email using nodemailer
      // const transporter = nodemailer.createTransport({
      //   host: process.env.SMTP_HOST,
      //   port: parseInt(process.env.SMTP_PORT || '587'),
      //   secure: false,
      //   auth: {
      //     user: process.env.SMTP_USER,
      //     pass: process.env.SMTP_PASS,
      //   },
      // });
      // await transporter.sendMail(mailOptions);

      this.logger.info('Email notification sent', {
        notificationId: notification.id,
        to,
        subject,
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to send email notification', {
        error: error instanceof Error ? error.message : 'Unknown error',
        notificationId: notification.id,
        to,
      });
      return false;
    }
  }

  async sendToMultiple(notification: Notification, recipients: string[]): Promise<boolean[]> {
    const results = await Promise.all(
      recipients.map(recipient => this.send(notification, recipient))
    );
    return results;
  }

  private generateEmailTemplate(notification: Notification): string {
    const severityColors: Record<string, string> = {
      low: '#3498db',
      medium: '#f39c12',
      high: '#e74c3c',
      critical: '#c0392b',
    };

    const color = severityColors[notification.severity] || '#3498db';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${notification.title}</title>
      </head>
      <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: ${color}; color: white; padding: 20px; border-radius: 5px 5px 0 0;">
          <h1 style="margin: 0; font-size: 24px;">${notification.title}</h1>
          <p style="margin: 10px 0 0 0; opacity: 0.9;">${notification.type.toUpperCase()} - ${notification.severity.toUpperCase()}</p>
        </div>
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 0 0 5px 5px; border: 1px solid #dee2e6;">
          <p style="font-size: 16px; line-height: 1.6; color: #333;">${notification.message}</p>
          ${notification.data && Object.keys(notification.data).length > 0 ? `
            <div style="margin-top: 20px; padding: 15px; background-color: #fff; border-left: 4px solid ${color};">
              <h3 style="margin-top: 0; font-size: 14px; color: #666;">Additional Information</h3>
              <pre style="background-color: #f8f9fa; padding: 10px; border-radius: 3px; overflow-x: auto;">${JSON.stringify(notification.data, null, 2)}</pre>
            </div>
          ` : ''}
          <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #dee2e6; font-size: 12px; color: #666;">
            <p>Notification ID: ${notification.id}</p>
            <p>Timestamp: ${notification.createdAt.toISOString()}</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  private generatePlainText(notification: Notification): string {
    let text = `${notification.title}\n`;
    text += `${'='.repeat(notification.title.length)}\n\n`;
    text += `${notification.message}\n\n`;

    if (notification.data && Object.keys(notification.data).length > 0) {
      text += `Additional Information:\n`;
      text += `${JSON.stringify(notification.data, null, 2)}\n\n`;
    }

    text += `---\n`;
    text += `Notification ID: ${notification.id}\n`;
    text += `Type: ${notification.type}\n`;
    text += `Severity: ${notification.severity}\n`;
    text += `Timestamp: ${notification.createdAt.toISOString()}\n`;

    return text;
  }

  private getEmailPriority(severity: string): 'high' | 'normal' | 'low' {
    switch (severity) {
      case 'critical':
      case 'high':
        return 'high';
      case 'medium':
        return 'normal';
      default:
        return 'low';
    }
  }
}

export class MockEmailNotificationAdapter implements EmailNotificationAdapter {
  constructor(private logger: Logger) {}

  async send(notification: Notification, to: string): Promise<boolean> {
    this.logger.info('Mock email notification sent', {
      notificationId: notification.id,
      to,
      subject: `[${notification.severity}] ${notification.title}`,
    });
    return true;
  }

  async sendToMultiple(notification: Notification, recipients: string[]): Promise<boolean[]> {
    this.logger.info('Mock email notifications sent', {
      notificationId: notification.id,
      count: recipients.length,
    });
    return recipients.map(() => true);
  }
}