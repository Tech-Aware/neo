import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import spinner from '../utils/spinner';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';

const USER_ADDRESS = ENV.USER_ADDRESS;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;

let temp_trades: UserActivityInterface[] = [];

const UserActivity = getUserActivityModel(USER_ADDRESS);

const readTempTrade = async () => {
    temp_trades = (
        await UserActivity.find({
            $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: { $lt: RETRY_LIMIT } }],
        }).exec()
    ).map((trade) => trade as UserActivityInterface);
};

const incrementBotExecutionAttempts = async (trade: UserActivityInterface) => {
    const updatedTrade = await UserActivity.findOneAndUpdate(
        { _id: trade._id },
        { $inc: { botExcutedTime: 1 } },
        { new: true }
    ).exec();

    if ((updatedTrade?.botExcutedTime ?? 0) >= RETRY_LIMIT) {
        await UserActivity.updateOne({ _id: trade._id }, { bot: true }).exec();
    }
};

const determineCondition = (trade: UserActivityInterface): 'merge' | 'buy' | 'sell' | null => {
    const tradeType = trade.type?.toUpperCase();
    if (tradeType === 'MERGE') {
        return 'merge';
    }

    const sideValue = trade.side?.toUpperCase();
    if (sideValue === 'MERGE') {
        return 'merge';
    }

    if (sideValue === 'BUY') {
        return 'buy';
    }

    if (sideValue === 'SELL') {
        return 'sell';
    }

    return null;
};

const doTrading = async (clobClient: ClobClient) => {
    for (const trade of temp_trades) {
        console.log('Trade to copy:', trade);
        try {
            const my_positionsResponse = await fetchData(
                `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
            );
            const user_positionsResponse = await fetchData(
                `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
            );

            const my_positions = Array.isArray(my_positionsResponse)
                ? (my_positionsResponse as UserPositionInterface[])
                : [];
            const user_positions = Array.isArray(user_positionsResponse)
                ? (user_positionsResponse as UserPositionInterface[])
                : [];

            const my_position = my_positions.find(
                (position: UserPositionInterface) => position.conditionId === trade.conditionId
            );
            const user_position = user_positions.find(
                (position: UserPositionInterface) => position.conditionId === trade.conditionId
            );
            const [my_balance, user_balance] = await Promise.all([
                getMyBalance(PROXY_WALLET),
                getMyBalance(USER_ADDRESS),
            ]);
            console.log('My current balance:', my_balance);
            console.log('User current balance:', user_balance);

            const condition = determineCondition(trade);
            if (!condition) {
                console.log('Unsupported trade action. Marking as executed to avoid retries.');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true }).exec();
                continue;
            }

            if (condition === 'buy' && my_balance <= 0) {
                console.log('Insufficient balance to copy buy trade.');
                await incrementBotExecutionAttempts(trade);
                continue;
            }

            await postOrder(clobClient, condition, my_position, user_position, trade, my_balance, user_balance);
        } catch (error) {
            console.error('Error while executing trade:', error);
            await incrementBotExecutionAttempts(trade);
        }
    }
};

const tradeExcutor = async (clobClient: ClobClient) => {
    console.log(`Executing Copy Trading`);

    while (true) {
        await readTempTrade();
        if (temp_trades.length > 0) {
            console.log('💥 New transactions found 💥');
            spinner.stop();
            await doTrading(clobClient);
        } else {
            spinner.start('Waiting for new transactions');
        }
    }
};

export default tradeExcutor;
