/**
 * The ranking half of the vector probe (#680), after ADR-0034's test:
 * twelve short notes, eight queries with one obvious expected note each,
 * and one nonsense query that should match nothing well.
 *
 * These are the probe's own texts, not the vault ADR-0034 was measured
 * on, so the numbers compare two backends of one model and nothing else.
 */
export type ProbeNote = { id: string; text: string };
export type ProbeQuery = { text: string; expected: string | null };

export const PROBE_NOTES: readonly ProbeNote[] = [
  {
    id: "sourdough",
    text: "Sourdough starter: feed it equal weights of flour and water every day, keep it at room temperature, and bake when it doubles in four hours.",
  },
  {
    id: "tax-deadline",
    text: "Tax return: the filing deadline is the end of November. Collect the medical receipts and the mortgage interest statement before the accountant meeting.",
  },
  {
    id: "bike-brakes",
    text: "Bicycle maintenance: the rear brake pads are worn to the metal and squeal. Replace both pads and true the rear wheel.",
  },
  {
    id: "kyoto-trip",
    text: "Kyoto trip plan: three nights near Gion, the bamboo grove at sunrise, the Fushimi Inari gates, and a day trip to Nara to see the deer.",
  },
  {
    id: "postgres-index",
    text: "Database note: the orders query was slow because of a sequential scan. A composite index on customer id and created date brought it from two seconds to ten milliseconds.",
  },
  {
    id: "tomato-garden",
    text: "Garden log: the tomato plants have yellow lower leaves, probably overwatering. Water at the base twice a week and add mulch.",
  },
  {
    id: "piano-practice",
    text: "Piano practice: scales in every major key with a metronome at eighty, then the left hand of the Chopin nocturne, slowly.",
  },
  {
    id: "team-retro",
    text: "Sprint retrospective: deployments took too long, code reviews waited for days. Action items: smaller pull requests and a review rota.",
  },
  {
    id: "ricetta-ragu",
    text: "Ricetta del ragù: soffritto di sedano, carota e cipolla, carne macinata mista, vino rosso, passata di pomodoro e tre ore di cottura a fuoco basso.",
  },
  {
    id: "wifi-router",
    text: "Home network: the router drops the connection every evening. Changed the wireless channel, updated the firmware and moved it away from the microwave.",
  },
  {
    id: "marathon-plan",
    text: "Marathon training: four runs a week, the long run on Sunday growing by two kilometres, and a taper in the last three weeks before the race.",
  },
  {
    id: "book-notes",
    text: "Reading notes on a history of the Roman republic: the Gracchi reforms, the Marian army, and how the senate lost control of its generals.",
  },
];

export const PROBE_QUERIES: readonly ProbeQuery[] = [
  { text: "how often should I feed my bread starter", expected: "sourdough" },
  { text: "documents I need for the tax filing", expected: "tax-deadline" },
  { text: "squeaky brakes on my bike", expected: "bike-brakes" },
  { text: "what to see in Japan", expected: "kyoto-trip" },
  { text: "why was the SQL query slow", expected: "postgres-index" },
  { text: "yellow leaves on my tomatoes", expected: "tomato-garden" },
  { text: "come si prepara il sugo di carne", expected: "ricetta-ragu" },
  { text: "internet keeps disconnecting at night", expected: "wifi-router" },
  { text: "zxqv blorptang frimble wug nnnn", expected: null },
];
