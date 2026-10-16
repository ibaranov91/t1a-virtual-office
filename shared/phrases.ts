// Everything the office's non-people say. Edit the copy here, not in the behaviour code.
// `idle` lines come up now and then on their own (a speech bubble for a few seconds); the others answer something you did.
export const PHRASES = {
  cleaner: {
    idle: ['Who left a cup AGAIN?', 'Spotless. Almost.', 'Mind the wet floor!', 'I saw that crumb.', 'Tables are not coat racks.',
      'Coffee rings: my nemesis.', 'Dust never sleeps.', 'Somebody loves their mug a bit too much.', 'Cleaner floors, calmer minds.', 'Do not feed the printer.'],
    praise: ['Oh! Thank you, dear.', 'Finally, someone with manners!', 'Look at you, tidying up!', 'I could kiss you. I won\'t.', 'A rare and beautiful sight.'], // you cleared a cup while she watched
  },
  cat: {
    idle: ['Mrrp.', 'Meow.', 'This keyboard is warm.', 'I was here first.', 'Feed me. Again.', 'Prrrr.', 'The red dot was a lie.', 'Stare contest. You lose.'],
    pet: ['Prrrrrr.', 'Acceptable.', 'Mrow~', 'Five more minutes.', 'Don\'t stop.'], // just been petted
    judge: ['Your blood type is now mojito.', 'I saw you petting that palm.', 'Purr my last email: drink water.',
      'Strong spirits. Weak pathfinding.', 'Meow. HR would like a word.', 'You smell like a retrospective.',
      'A stand-up? You can barely stand.', 'That coconut is your new manager.', 'I judge. You hydrate.',
      'Nine lives. Zero hangovers. Learn.'], // sitting beside a drunk person
  },
  dog: {
    idle: ['Woof!', 'Ball? Ball? BALL?', 'Who\'s a good boy? Me.', 'Something smells like lunch.', 'Sniff sniff.', 'Walk? Walk!', 'I heard the fridge.', 'Wag wag wag.'],
    pet: ['Best. Day. Ever.', 'Woof woof!', 'More ears, please.', 'Friend!', 'Belly next?'],
  },
  bouncer: {
    idle: ['Not tonight.', 'ID?', 'No photos inside.', 'The line starts there.', 'Wrong shoes.', 'I know a guy.', 'Don\'t ask what\'s in it.', 'Techno only. House is a lifestyle.'],
    deal: ['The bouncer slips you something 💊', 'Bouncer: "Didn\'t get it from me." 💊', 'Bouncer: "Don\'t do it all at once." 💊', 'Bouncer: "First one\'s... not free." 💊'], // a notice when he hands something over
  },
} as const;
export type Speaker = keyof typeof PHRASES;
/** A random line of that kind for that speaker. */
export const phrase = <S extends Speaker>(who: S, kind: keyof typeof PHRASES[S]): string => {
  const xs = PHRASES[who][kind] as readonly string[];
  return xs[Math.floor(Math.random() * xs.length)];
};
