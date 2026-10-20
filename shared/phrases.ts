// Everything the office's non-people say. Edit the copy here, not in the behaviour code.
// `idle` lines come up now and then on their own (a speech bubble for a few seconds); the others answer something you did.
export const PHRASES = {
  cleaner: {
    idle: ['Who left a cup AGAIN?', 'Spotless. Almost.', 'Mind the wet floor!', 'I saw that crumb.', 'Tables are not coat racks.',
      'Coffee rings: my nemesis.', 'Dust never sleeps.', 'Somebody loves their mug a bit too much.', 'Cleaner floors, calmer minds.', 'Do not feed the printer.'],
    praise: ['Oh! Thank you, dear.', 'Finally, someone with manners!', 'Look at you, tidying up!', 'I could kiss you. I won\'t.', 'A rare and beautiful sight.'], // you cleared a cup while she watched
    thanks: ['Oh, for me? Lovely.', 'Straight into my hands. A professional.', 'Bless you, dear.', 'You can stay.', 'I will pretend this is a tip.'], // you handed her your empty cup
  },
  cat: {
    idle: ['Mrrp.', 'Meow.', 'This keyboard is warm.', 'I was here first.', 'Feed me. Again.', 'Prrrr.', 'The red dot was a lie.', 'Stare contest. You lose.'],
    pet: ['Prrrrrr.', 'Acceptable.', 'Mrow~', 'Five more minutes.', 'Don\'t stop.'], // just been petted
    judge: ['Your blood type is now mojito.', 'I saw you petting that palm.', 'Purr my last email: drink water.',
      'Strong spirits. Weak pathfinding.', 'Meow. HR would like a word.', 'You smell like a retrospective.',
      'A stand-up? You can barely stand.', 'That coconut is your new manager.', 'I judge. You hydrate.',
      'Nine lives. Zero hangovers. Learn.'], // sitting beside a drunk person
    water: ['Wet. Rude.', 'Nope.', 'Absolutely not.', 'Who spilled the sea?', 'I\'ll admire it from here.', 'Pass.'], // backing off after a paw in the water
  },
  dog: {
    idle: ['Woof!', 'Ball? Ball? BALL?', 'Who\'s a good boy? Me.', 'Something smells like lunch.', 'Sniff sniff.', 'Walk? Walk!', 'I heard the fridge.', 'Wag wag wag.'],
    pet: ['Best. Day. Ever.', 'Woof woof!', 'More ears, please.', 'Friend!', 'Belly next?'],
    shake: ['Splash!', 'Shake shake shake!', 'Who wants a hug?', 'Wet dog incoming!', 'Best. Swim. Ever.'], // out of the water
  },
  bouncer: {
    idle: ['Not tonight.', 'ID?', 'No photos inside.', 'The line starts there.', 'Wrong shoes.', 'I know a guy.', 'Don\'t ask what\'s in it.', 'Techno only. House is a lifestyle.'],
    deal: ['The bouncer slips you something 💊', 'Bouncer: "Didn\'t get it from me." 💊', 'Bouncer: "Don\'t do it all at once." 💊', 'Bouncer: "First one\'s... not free." 💊'], // a notice when he hands something over
  },
  // the 7/11 cashier, Keiko (Convenience Store Woman): polite, literal, devoted to the store and its manual. `{items}` is what you took.
  keiko: {
    greeting: ['Irasshaimase! Welcome! I said it at the correct volume. Thank you.', 'The store heard the door. The store is happy. I am part of the store, so I am also happy.',
      'Good morning. I practised this smile in the freezer door reflection.', 'Hello. I am behaving like a normal person today. Please tell me if I stop.'], // you walk in
    checkout: ['Would you like this warmed up? I ask everyone. Even about the umbrella.', 'That is your last one today. The manual says so. I love the manual.',
      'Do you need a bag? You do not have hands for a bag. I will imagine the bag for you.', '{items}. Yesterday too. You are a very regular customer. That is good.'], // you took something
    idle: ['If you listen, the shelves tell you what is missing. The onigiri are lonely.', 'I have worked here eighteen years. The store opened this morning. Both are true.',
      'I speak like the last customer. Today I am a little bit like you.', 'My family asked when I will be cured. I said: after my shift.'],
    talk: ['You are not buying anything. I do not know what you are. Please buy something so I know.', 'People ask if I will marry. I am married to the 7/11. We are very happy. Mostly.',
      'That is not in the manual. Irasshaimase!', 'Outside the store I am not sure which way to face. In here, I face you.'], // you talk to her or linger
  },
} as const;
export type Speaker = keyof typeof PHRASES;
/** A random line of that kind for that speaker. */
export const phrase = <S extends Speaker>(who: S, kind: keyof typeof PHRASES[S]): string => {
  const xs = PHRASES[who][kind] as readonly string[];
  return xs[Math.floor(Math.random() * xs.length)];
};

/** What Keiko says after a checkout. The 4th line names what you took ("Onigiri and a slurpee"); the "last one today" line comes with the third item. */
export function keikoCheckout(taken: readonly string[], names: readonly string[], rnd = Math.random): string {
  const lines = PHRASES.keiko.checkout;
  if (taken.length >= 3) return lines[1];
  if (taken.length >= 2) { const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)!.toLowerCase()}` : names[0]; return lines[3].replace('{items}', list); }
  return [lines[0], lines[2]][Math.floor(rnd() * 2)];
}
