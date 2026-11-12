export function hotelSearchFilter(query: string) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  return { $and: terms.map(term => ({ $or: ['name', 'city', 'province', 'state', 'country', 'countryCode', 'locationName']
    .map(field => ({ [field]: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } })) })) };
}
