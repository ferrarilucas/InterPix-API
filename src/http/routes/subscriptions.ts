import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/errors';
import {
  cancelSubscription,
  createSubscription,
  getSubscriptionDetail,
} from '../../domain/subscriptionService';
import { config } from '../../shared/config';
import { businessToday, MIN_LEAD_DAYS, minimumFirstDueDate } from '../../domain/schedule';

const REQUIRED_LEAD_DAYS = Math.max(config.chargeLeadDays, MIN_LEAD_DAYS);

const createSchema = z.object({
  externalUserId: z.string().min(1).max(128),
  planCode: z.string().min(1).max(64),
  amount: z.string().regex(/^\d+\.\d{2}$/),
  intervalMonths: z.number().int().min(1).max(12),
  firstDueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => value >= minimumFirstDueDate(businessToday(), config.chargeLeadDays), {
      message: `firstDueDate precisa de no minimo ${REQUIRED_LEAD_DAYS} dias de antecedencia`,
    }),
  debtor: z.object({
    taxId: z.string().regex(/^\d{11}$|^\d{14}$/),
    name: z.string().min(1).max(200),
  }),
});

function toValidationDetails(issues: z.ZodIssue[]): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function subscriptionRoutes(): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    const parsed = createSchema.safeParse(req.body);

    if (!parsed.success) {
      next(AppError.badRequest('Payload invalido.', toValidationDetails(parsed.error.issues)));
      return;
    }

    try {
      const result = await createSubscription(parsed.data);
      res.status(201).json({
        id: result.subscription.id,
        status: result.subscription.status,
        externalUserId: result.subscription.externalUserId,
        planCode: result.subscription.planCode,
        amount: result.subscription.amount,
        nextDueDate: result.subscription.nextDueDate,
        authorization: result.authorization,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { subscription, cycles } = await getSubscriptionDetail(req.params.id);
      res.status(200).json({
        id: subscription.id,
        status: subscription.status,
        externalUserId: subscription.externalUserId,
        planCode: subscription.planCode,
        amount: subscription.amount,
        nextDueDate: subscription.nextDueDate,
        authorizedAt: subscription.authorizedAt,
        canceledAt: subscription.canceledAt,
        cycles: cycles.map((cycle) => ({
          seq: cycle.seq,
          dueDate: cycle.dueDate,
          amount: cycle.amount,
          status: cycle.status,
          paidAt: cycle.paidAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await cancelSubscription(req.params.id);
      res.status(200).json({
        id: result.subscription.id,
        status: result.subscription.status,
        canceledAt: result.subscription.canceledAt,
        pendingCycle: result.pendingCycle
          ? {
              seq: result.pendingCycle.seq,
              dueDate: result.pendingCycle.dueDate,
              status: result.pendingCycle.status,
              note: 'Cobranca ja enviada; nao pode ser cancelada e seguira seu curso.',
            }
          : null,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
