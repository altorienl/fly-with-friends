/* Worker unit tests: bag-text parsing (checked against the Python parser in
 * .github/scripts/scan.py) and request validation. Run: node test-worker.js */
import { _internals } from './worker.js';
const { parseBags, validate } = _internals;

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
};

console.log('\n1. Bag parsing');
const cases = [
  [['Checked baggage for a fee'], 'fee_unknown', null, null],
  [['1st checked bag: 35'], 'parsed', 35, null],
  [['First checked bag: $40', 'Free carry-on'], 'parsed', 40, true],
  [['1 free checked bag'], 'parsed', 0, null],
  [['Carry-on bag not included', 'Checked bag: 30'], 'parsed', 30, false],
  [['Bag and fare conditions depend on the return flight'], 'fee_unknown', null, null],
  [['Below average legroom (29 in)'], 'absent', null, null],
  [[], 'absent', null, null],
];
for (const [ext, conf, price, carry] of cases) {
  const got = parseBags(ext);
  check(JSON.stringify(ext).slice(0, 52),
    got.confidence === conf && got.checked_first_price === price && got.carry_on_included === carry,
    'got ' + JSON.stringify(got));
}

console.log('\n2. Validation rejects bad input');
const base = { travelers: [{ id: 'a', origins: ['SFO'] }, { id: 'b', origins: ['ORD'] }],
               dest: ['PIT'], depart: '2027-02-12', ret: '2027-02-15' };
const bad = [
  ['one person', { ...base, travelers: [base.travelers[0]] }],
  ['nine people', { ...base, travelers: Array.from({ length: 9 }, (_, i) => ({ id: 'p' + i, origins: ['SFO'] })) }],
  ['lowercase dest', { ...base, dest: ['pit'] }],
  ['no dest', { ...base, dest: [] }],
  ['bad date', { ...base, depart: '12/02/2027' }],
  ['return before depart', { ...base, ret: '2027-02-01' }],
  ['origin not a code', { ...base, travelers: [{ id: 'a', origins: ['San Francisco'] }, base.travelers[1]] }],
  ['empty origins', { ...base, travelers: [{ id: 'a', origins: [] }, base.travelers[1]] }],
];
for (const [name, body] of bad) check('rejects ' + name, validate(body) !== null, 'got null');
check('accepts a valid round trip', validate(base) === null, validate(base));
check('accepts a valid one-way', validate({ ...base, ret: null }) === null);
check('accepts multi-airport origins', validate({ ...base,
  travelers: [{ id: 'a', origins: ['SFO', 'OAK', 'SJC'] }, base.travelers[1]] }) === null);

console.log('\n3. Duffel: ISO durations');
const { parseIsoDuration, duffelBags, extractDuffelOptions, localStamp } = _internals;
check('PT5H30M -> 330', parseIsoDuration('PT5H30M') === 330);
check('PT11H -> 660', parseIsoDuration('PT11H') === 660);
check('PT45M -> 45', parseIsoDuration('PT45M') === 45);
check('P1DT2H30M -> 1590', parseIsoDuration('P1DT2H30M') === 1590, 'got ' + parseIsoDuration('P1DT2H30M'));
check('junk -> null', parseIsoDuration('banana') === null);
check('localStamp trims ISO to wall clock',
  localStamp('2027-03-10T14:30:00') === '2027-03-10 14:30', localStamp('2027-03-10T14:30:00'));

console.log('\n4. Duffel: baggage is "what is included", not "what it costs"');
check('checked bag included -> known free',
  JSON.stringify(duffelBags({ baggages: [{ type: 'checked', quantity: 1 }, { type: 'carry_on', quantity: 1 }] }))
  === JSON.stringify({ carry_on_included: true, checked_first_price: 0, confidence: 'parsed' }));
check('no checked bag -> chargeable, amount unknown, carry-on still known',
  JSON.stringify(duffelBags({ baggages: [{ type: 'carry_on', quantity: 1 }] }))
  === JSON.stringify({ carry_on_included: true, checked_first_price: null, confidence: 'fee_unknown' }));
check('basic economy with nothing -> carry_on_included false (Google never gave us this)',
  JSON.stringify(duffelBags({ baggages: [] }))
  === JSON.stringify({ carry_on_included: false, checked_first_price: null, confidence: 'fee_unknown' }));
check('missing passenger object does not throw',
  duffelBags(undefined).confidence === 'fee_unknown');

console.log('\n5. Duffel: transatlantic normalisation');
(function () {
  // SFO 14:30 -> LHR 08:45 next day. Subtracting local wall clock gives 18h 15m;
  // the real duration is 10h 15m. This is the London case that makes using
  // Duffel's own duration field mandatory rather than tidy.
  const payload = { data: { offers: [
    { total_amount: '612.40', total_currency: 'USD',
      passengers: [{ baggages: [{ type: 'checked', quantity: 1 }, { type: 'carry_on', quantity: 1 }] }],
      slices: [{ duration: 'PT10H15M', fare_brand_name: 'Economy Standard',
        segments: [{
          departing_at: '2027-03-10T14:30:00', arriving_at: '2027-03-11T08:45:00',
          origin: { iata_code: 'SFO' }, destination: { iata_code: 'LHR' },
          marketing_carrier: { name: 'British Airways', iata_code: 'BA',
                               logo_symbol_url: 'https://assets.duffel.com/img/airlines/BA.svg' },
        }] }] },
    { total_amount: '438.00', total_currency: 'USD',
      passengers: [{ baggages: [] }],
      slices: [{ duration: 'PT13H05M', fare_brand_name: 'Basic',
        segments: [
          { departing_at: '2027-03-10T07:10:00', arriving_at: '2027-03-10T15:40:00',
            origin: { iata_code: 'SFO' }, destination: { iata_code: 'JFK' },
            marketing_carrier: { name: 'American Airlines', iata_code: 'AA' } },
          { departing_at: '2027-03-10T18:00:00', arriving_at: '2027-03-11T06:15:00',
            origin: { iata_code: 'JFK' }, destination: { iata_code: 'LHR' },
            marketing_carrier: { name: 'British Airways', iata_code: 'BA' } },
        ] }] },
  ] } };

  const opts = extractDuffelOptions(payload, 25);
  check('two offers normalised', opts.length === 2);
  check('sorted cheapest first', opts[0].price === 438 && opts[1].price === 612.4,
    JSON.stringify(opts.map(o => o.price)));

  const cheap = opts[0], standard = opts[1];
  check('duration comes from the ISO field, not local subtraction',
    cheap.duration_minutes === 785 && standard.duration_minutes === 615,
    JSON.stringify([cheap.duration_minutes, standard.duration_minutes]));
  check('local subtraction would have been wrong',
    (Date.parse(standard.arrive.replace(' ', 'T')) - Date.parse(standard.depart.replace(' ', 'T'))) / 60000 === 1095);
  check('stops counted from segments', cheap.stops === 1 && standard.stops === 0,
    JSON.stringify([cheap.stops, standard.stops]));
  check('route taken from first origin and last destination',
    cheap.from === 'SFO' && cheap.to === 'LHR');
  check('both carriers listed on the connection',
    JSON.stringify(cheap.airlines) === JSON.stringify(['American Airlines', 'British Airways']),
    JSON.stringify(cheap.airlines));
  check('logo url carried through', standard.airline_logo.indexOf('duffel.com') > -1);
  check('fare brand captured', cheap.fare_brand === 'Basic' && standard.fare_brand === 'Economy Standard');

  // The whole point of the switch: the bag assumption now lands on one option
  // and not the other, so it can actually change which plan wins.
  check('basic fare known to need a bag', cheap.bags.confidence === 'fee_unknown'
    && cheap.bags.carry_on_included === false);
  check('standard fare known to include one', standard.bags.confidence === 'parsed'
    && standard.bags.checked_first_price === 0);
  check('the two differ, unlike under SerpApi',
    cheap.bags.confidence !== standard.bags.confidence);
})();

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
