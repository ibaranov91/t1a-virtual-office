// The rewards table (engine item 6): milestones and what they give. A reward is a fixed item or "pick one from a pool".
import { ACHIEVEMENT_HATS, hatItem } from './effects';

export interface MilestoneReward { at: number; pick: readonly string[] } // at: achievements earned; pick: item ids to choose from
/** Achievement hats (decision 3): at 5, 10 and 15 achievements you pick any hat you don't own yet. */
export const HAT_REWARDS: readonly MilestoneReward[] = [5, 10, 15].map(at => ({ at, pick: ACHIEVEMENT_HATS.map(hatItem) }));

/** How many picks someone has coming: milestones reached minus picks already taken. */
export const picksDue = (earned: number, taken = 0, rewards = HAT_REWARDS) => Math.max(0, rewards.filter(r => earned >= r.at).length - taken);
/** The hats on offer to someone who holds `items`: the pool without what they already own. */
export const hatChoices = (items: readonly string[], rewards = HAT_REWARDS) => [...new Set(rewards.flatMap(r => r.pick))].filter(i => !items.includes(i));
