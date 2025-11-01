import moment from 'moment';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';

const USER_ADDRESS = ENV.USER_ADDRESS;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!USER_ADDRESS) {
    throw new Error('USER_ADDRESS is not defined');
}

const UserActivity = getUserActivityModel(USER_ADDRESS);
const UserPosition = getUserPositionModel(USER_ADDRESS);

let temp_trades: UserActivityInterface[] = [];

type ActivityPayload = Partial<UserActivityInterface> & {
    transactionHash?: string;
    timestamp?: number | string;
    type?: string;
    side?: string;
    asset?: string;
};

type PositionPayload = Partial<UserPositionInterface> & {
    asset?: string;
    conditionId?: string;
};

const toArray = <T>(data: unknown, keys: string[]): T[] => {
    if (Array.isArray(data)) {
        return data as T[];
    }

    if (data && typeof data === 'object') {
        for (const key of keys) {
            const nested = (data as Record<string, unknown>)[key];
            if (Array.isArray(nested)) {
                return nested as T[];
            }
        }
    }

    return [];
};

const normaliseTimestamp = (value: number | string | undefined): number | null => {
    if (value === undefined || value === null) {
        return null;
    }

    const numeric = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(numeric)) {
        return null;
    }

    return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : numeric;
};

const init = async () => {
    temp_trades = (await UserActivity.find().exec()).map((trade) => trade as UserActivityInterface);
};

const fetchTradeData = async () => {
    try {
        const cutoffTimestamp = moment().subtract(TOO_OLD_TIMESTAMP, 'hours').unix();

        const [activitiesResponse, positionsResponse] = await Promise.all([
            fetchData(`https://data-api.polymarket.com/activities?user=${USER_ADDRESS}`),
            fetchData(`https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`),
        ]);

        const rawActivities = toArray<ActivityPayload>(activitiesResponse, ['data', 'activities', 'results']);
        const rawPositions = toArray<PositionPayload>(positionsResponse, ['data', 'positions', 'results']);

        const validActivities = rawActivities.filter((activity) => {
            const timestamp = normaliseTimestamp(activity.timestamp);
            if (timestamp === null || timestamp < cutoffTimestamp) {
                return false;
            }

            if (typeof activity.transactionHash !== 'string' || activity.transactionHash.length === 0) {
                return false;
            }

            const asset = typeof activity.asset === 'string' ? activity.asset : '';
            if (asset.length === 0) {
                return false;
            }

            const activityType = typeof activity.type === 'string' ? activity.type.toUpperCase() : '';
            const side = typeof activity.side === 'string' ? activity.side : '';

            if (activityType !== 'MERGE' && side.length === 0) {
                return false;
            }

            return activityType === 'TRADE' || activityType === 'MERGE';
        });

        const activityDocuments = validActivities.map((activity) => {
            const timestamp = normaliseTimestamp(activity.timestamp) ?? cutoffTimestamp;
            return {
                proxyWallet: activity.proxyWallet ?? USER_ADDRESS,
                timestamp,
                conditionId: activity.conditionId ?? '',
                type: activity.type ?? 'TRADE',
                size: Number(activity.size ?? 0),
                usdcSize: Number(activity.usdcSize ?? 0),
                transactionHash: activity.transactionHash as string,
                price: Number(activity.price ?? 0),
                asset: (activity.asset as string) ?? '',
                side: (activity.side as string) ?? '',
                outcomeIndex: Number(activity.outcomeIndex ?? 0),
                title: activity.title ?? '',
                slug: activity.slug ?? '',
                icon: activity.icon ?? '',
                eventSlug: activity.eventSlug ?? '',
                outcome: activity.outcome ?? '',
                name: activity.name ?? '',
                pseudonym: activity.pseudonym ?? '',
                bio: activity.bio ?? '',
                profileImage: activity.profileImage ?? '',
                profileImageOptimized: activity.profileImageOptimized ?? '',
                bot: false,
                botExcutedTime: 0,
            } satisfies Omit<UserActivityInterface, '_id'>;
        });

        const recentActivityHashes = new Set(
            activityDocuments.map((activity) => activity.transactionHash)
        );

        temp_trades = temp_trades.filter((trade) => {
            const timestamp = normaliseTimestamp(trade.timestamp);
            if (timestamp === null) {
                return false;
            }

            return timestamp >= cutoffTimestamp || recentActivityHashes.has(trade.transactionHash);
        });

        for (const activity of activityDocuments) {
            const alreadyTracked = temp_trades.some(
                (stored) => stored.transactionHash === activity.transactionHash
            );
            const { bot, botExcutedTime, ...activityData } = activity;

            await UserActivity.updateOne(
                { transactionHash: activity.transactionHash },
                {
                    $set: activityData,
                    $setOnInsert: { bot, botExcutedTime },
                },
                { upsert: true }
            ).exec();

            if (!alreadyTracked) {
                const storedTrade = await UserActivity.findOne({
                    transactionHash: activity.transactionHash,
                }).exec();

                if (storedTrade) {
                    temp_trades.push(storedTrade as UserActivityInterface);
                }
            }
        }

        const positionDocuments = rawPositions
            .filter(
                (position): position is PositionPayload & { asset: string; conditionId: string } =>
                    typeof position.asset === 'string' &&
                    position.asset.length > 0 &&
                    typeof position.conditionId === 'string' &&
                    position.conditionId.length > 0
            )
            .map((position) => ({
                proxyWallet: position.proxyWallet ?? USER_ADDRESS,
                asset: position.asset,
                conditionId: position.conditionId,
                size: Number(position.size ?? 0),
                avgPrice: Number(position.avgPrice ?? 0),
                initialValue: Number(position.initialValue ?? 0),
                currentValue: Number(position.currentValue ?? 0),
                cashPnl: Number(position.cashPnl ?? 0),
                percentPnl: Number(position.percentPnl ?? 0),
                totalBought: Number(position.totalBought ?? 0),
                realizedPnl: Number(position.realizedPnl ?? 0),
                percentRealizedPnl: Number(position.percentRealizedPnl ?? 0),
                curPrice: Number(position.curPrice ?? 0),
                redeemable: Boolean(position.redeemable),
                mergeable: Boolean(position.mergeable),
                title: position.title ?? '',
                slug: position.slug ?? '',
                icon: position.icon ?? '',
                eventSlug: position.eventSlug ?? '',
                outcome: position.outcome ?? '',
                outcomeIndex: Number(position.outcomeIndex ?? 0),
                oppositeOutcome: position.oppositeOutcome ?? '',
                oppositeAsset: position.oppositeAsset ?? '',
                endDate: position.endDate ?? '',
                negativeRisk: Boolean(position.negativeRisk),
            } satisfies Omit<UserPositionInterface, '_id'>));

        await Promise.all(
            positionDocuments.map((position) =>
                UserPosition.updateOne(
                    { asset: position.asset, conditionId: position.conditionId },
                    { $set: position },
                    { upsert: true }
                ).exec()
            )
        );
    } catch (error) {
        console.error('Error fetching trade data:', error);
    }
};

const tradeMonitor = async () => {
    console.log('Trade Monitor is running every', FETCH_INTERVAL, 'seconds');
    await init();    //Load my oders before sever downs
    while (true) {
        await fetchTradeData();     //Fetch all user activities
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));     //Fetch user activities every second
    }
};

export default tradeMonitor;
