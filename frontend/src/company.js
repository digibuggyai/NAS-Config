/* Company details as they appear on customer-facing documents.
 *
 * One file so the letterhead is edited in one place. Anything left empty is
 * simply omitted from the document rather than printed blank.
 */

export const COMPANY = {
  name: "DigiBuggy",
  legalName: "DigiBuggy (DGB India)",
  tagline: "NETWORK ATTACHED STORAGE",

  address: [
    "207, Second Floor, Mansarovar Building",
    "90 Nehru Place, New Delhi 110019"
  ],

  phone: "+91 92176 67394",
  email: "sales@digibuggy.com",

  // Fill these in and they appear automatically.
  website: "",
  gstin: "",
  cin: ""
};

/** The contact line for a footer: whatever is filled in, separated by dots. */
export function contactLine(){
  return [COMPANY.phone, COMPANY.email, COMPANY.website].filter(Boolean).join("   ·   ");
}

/** Registration numbers, when there are any to show. */
export function registrationLine(){
  return [
    COMPANY.gstin && `GSTIN: ${COMPANY.gstin}`,
    COMPANY.cin && `CIN: ${COMPANY.cin}`
  ].filter(Boolean).join("   ·   ");
}
