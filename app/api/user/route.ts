// app/api/user/route.ts

import { NextResponse } from 'next/server';
import prisma from '@/utils/prisma';
import { MAX_ENERGY_REFILLS_PER_DAY, energyUpgradeBaseBenefit, REFERRAL_BONUS_BASE, REFERRAL_BONUS_PREMIUM, LEVELS } from '@/utils/consts';
import { validateTelegramWebAppData } from '@/utils/server-checks';
import { calculateEnergyLimit, calculateLevelIndex, calculateMinedPoints, calculateRestoredEnergy } from '@/utils/game-mechanics';

export async function POST(req: Request) {
  console.log("SERVER USER CALL!!!");

  const body = await req.json();
  const { telegramInitData, referrerTelegramId } = body;

  console.log("Request body:", body);

  if (!telegramInitData) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { validatedData, user: telegramUser } = validateTelegramWebAppData(telegramInitData);

  if (!validatedData) {
    return NextResponse.json({ error: 'Invalid Telegram data' }, { status: 403 });
  }

  if (!telegramUser?.id) {
    return NextResponse.json({ error: 'Invalid user data' }, { status: 400 });
  }

  const telegramId = telegramUser.id.toString();
  const isPremium = telegramUser?.is_premium || false;

  try {
    const dbUserUpdated = await prisma.$transaction(async (prisma) => {
      let dbUser = await prisma.user.findUnique({
        where: { telegramId },
        include: { referredBy: true },
      });

      const currentTime = new Date();

      if (dbUser) {
        const minedPoints = calculateMinedPoints(
          dbUser.mineLevelIndex,
          dbUser.lastPointsUpdateTimestamp.getTime(),
          currentTime.getTime()
        );

        const newPoints = dbUser.points + minedPoints;
        const newLevelIndex = calculateLevelIndex(newPoints);
        const oldLevelIndex = calculateLevelIndex(dbUser.points);

        const lastEnergy = dbUser.energy;
        const restoredEnergy = calculateRestoredEnergy(dbUser.multitapLevelIndex, dbUser.lastEnergyUpdateTimestamp.getTime(), currentTime.getTime());
        const maxEnergyLimit = calculateEnergyLimit(dbUser.energyLimitLevelIndex);

        const lastRefillDate = new Date(dbUser.lastEnergyRefillsTimestamp);
        const isNewDay = currentTime.getUTCDate() !== lastRefillDate.getUTCDate() ||
          currentTime.getUTCMonth() !== lastRefillDate.getUTCMonth() ||
          currentTime.getUTCFullYear() !== lastRefillDate.getUTCFullYear();

        let additionalReferralPoints = 0;
        if (newLevelIndex > oldLevelIndex) {
          for (let i = oldLevelIndex + 1; i <= newLevelIndex; i++) {
            additionalReferralPoints += isPremium ? LEVELS[i].friendBonusPremium : LEVELS[i].friendBonus;
          }
        }

        dbUser = await prisma.user.update({
          where: { telegramId },
          data: {
            name: telegramUser.first_name || "",
            isPremium,
            points: newPoints,
            pointsBalance: { increment: minedPoints },
            offlinePointsEarned: minedPoints,
            referralPointsEarned: { increment: additionalReferralPoints },
            lastPointsUpdateTimestamp: currentTime,
            energy: Math.min(lastEnergy + restoredEnergy, maxEnergyLimit),
            energyRefillsLeft: isNewDay ? MAX_ENERGY_REFILLS_PER_DAY : dbUser.energyRefillsLeft,
            lastEnergyUpdateTimestamp: currentTime,
            lastEnergyRefillsTimestamp: isNewDay ? currentTime : dbUser.lastEnergyRefillsTimestamp,
          },
          include: { referredBy: true },
        });

        if (additionalReferralPoints > 0 && dbUser.referredBy) {
          await prisma.user.update({
            where: { id: dbUser.referredBy.id },
            data: {
              points: { increment: additionalReferralPoints },
              pointsBalance: { increment: additionalReferralPoints },
            },
          });
        }
      } else {
        let referredByUser = null;
        if (referrerTelegramId) {
          referredByUser = await prisma.user.findUnique({
            where: { telegramId: referrerTelegramId },
          });
        }

        const referralBonus = referredByUser ? (isPremium ? REFERRAL_BONUS_PREMIUM : REFERRAL_BONUS_BASE) : 0;
        const initialLevel = calculateLevelIndex(referralBonus);

        let initialReferralPoints = referralBonus;
        if (referredByUser) {
          for (let i = 1; i <= initialLevel; i++) {
            initialReferralPoints += isPremium ? LEVELS[i].friendBonusPremium : LEVELS[i].friendBonus;
          }
        }

        dbUser = await prisma.user.create({
          data: {
            telegramId,
            name: telegramUser.first_name || "",
            isPremium,
            points: referralBonus,
            pointsBalance: referralBonus,
            offlinePointsEarned: 0,
            referralPointsEarned: initialReferralPoints,
            multitapLevelIndex: 0,
            energy: energyUpgradeBaseBenefit,
            energyRefillsLeft: MAX_ENERGY_REFILLS_PER_DAY,
            energyLimitLevelIndex: 0,
            mineLevelIndex: 0,
            lastPointsUpdateTimestamp: currentTime,
            lastEnergyUpdateTimestamp: currentTime,
            lastEnergyRefillsTimestamp: currentTime,
            referredBy: referredByUser ? { connect: { id: referredByUser.id } } : undefined,
          },
          include: { referredBy: true },
        });

        if (referredByUser) {
          await prisma.user.update({
            where: { id: referredByUser.id },
            data: {
              points: { increment: initialReferralPoints },
              pointsBalance: { increment: initialReferralPoints },
              referrals: { connect: { id: dbUser.id } },
            },
          });
        }
      }

      return dbUser;
    });

    return NextResponse.json(dbUserUpdated);
  } catch (error) {
    console.error('Error fetching/creating user:', error);
    return NextResponse.json({ error: 'Failed to fetch/create user' }, { status: 500 });
  }
}
