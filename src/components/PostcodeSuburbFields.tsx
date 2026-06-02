import { suburbsForPostcode, isValidWaPostcode } from '../lib/wa-postcodes'

// SPEC_PROFILE_POSTCODE_SUBURB — reusable controlled postcode + suburb pair.
// Postcode is a 4-digit text box (WA only); suburb is a dropdown populated from the
// postcode. Used by signup, profile, the login hard-block gate, and admin edit/create.

export interface PostcodeSuburbValue {
  postcode: string
  suburb: string
}

interface Props {
  value: PostcodeSuburbValue
  onChange: (next: PostcodeSuburbValue) => void
  showConsentNote?: boolean
  idPrefix?: string
  disabled?: boolean
}

const inputClass =
  'w-full px-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all disabled:opacity-50 disabled:cursor-not-allowed'
const labelClass = 'text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1.5 block'

export default function PostcodeSuburbFields({ value, onChange, showConsentNote = true, idPrefix = 'loc', disabled }: Props) {
  const { postcode, suburb } = value
  const suburbs = suburbsForPostcode(postcode)
  const postcodeLooksComplete = postcode.length === 4
  const postcodeInvalid = postcodeLooksComplete && !isValidWaPostcode(postcode)

  const handlePostcode = (raw: string) => {
    const pc = raw.replace(/\D/g, '').slice(0, 4)
    const list = suburbsForPostcode(pc)
    let nextSuburb = suburb
    if (list.length === 1) nextSuburb = list[0]
    else if (!list.some((s) => s.toLowerCase() === suburb.toLowerCase())) nextSuburb = ''
    onChange({ postcode: pc, suburb: nextSuburb })
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label htmlFor={`${idPrefix}-postcode`} className={labelClass}>
          Postcode
        </label>
        <input
          id={`${idPrefix}-postcode`}
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={4}
          value={postcode}
          onChange={(e) => handlePostcode(e.target.value)}
          placeholder="6000"
          disabled={disabled}
          className={inputClass}
        />
        {postcodeInvalid && (
          <p className="text-xs text-red-600 dark:text-red-400 mt-1">Enter a valid WA postcode (4 digits, starting with 6).</p>
        )}
      </div>
      <div>
        <label htmlFor={`${idPrefix}-suburb`} className={labelClass}>
          Suburb
        </label>
        <select
          id={`${idPrefix}-suburb`}
          value={suburb}
          onChange={(e) => onChange({ postcode, suburb: e.target.value })}
          disabled={disabled || suburbs.length === 0}
          className={inputClass}
        >
          <option value="">{suburbs.length === 0 ? 'Enter postcode first' : 'Select suburb…'}</option>
          {suburbs.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {showConsentNote && (
        <p className="col-span-2 text-xs text-gray-400 dark:text-gray-500 -mt-1">
          Used to understand where our customers travel from.
        </p>
      )}
    </div>
  )
}

/** True iff the value is a complete, valid WA postcode + matching suburb. */
export function isLocationComplete(v: PostcodeSuburbValue): boolean {
  if (!isValidWaPostcode(v.postcode)) return false
  return suburbsForPostcode(v.postcode).some((s) => s.toLowerCase() === v.suburb.trim().toLowerCase())
}
