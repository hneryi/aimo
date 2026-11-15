// Shared by chat routing and its waiting label; no product or dietary decisions live here.
export function isIngredientRequest(message: string): boolean {
  return /raaka[ -]?aine|aineks|ingredien|råvar|leivo|leipo|\b(?:bake|cook|baka|lagar|matlagning)\b|(?:tehdä|teen|valmista|make|making|baking|cooking).*(?:kakku|kakun|keitto|soppa|cake|soup|tårta)/i.test(message);
}
