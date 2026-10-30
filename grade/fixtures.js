/* Hand-built trips for grading the matcher.
 *
 * PROVENANCE. Route structure, carrier presence, nonstop/connection topology and
 * block times are real (e.g. ORD-MSN is a 1h00 nonstop on AA/UA; CHS-MSN has no
 * nonstop and realistically two usable itineraries a day; CLT-BNA is a 1h30
 * American monopoly short hop; BOS-DEN is 4h40 block). Every DEPARTURE TIME and
 * every FARE below is INVENTED but kept inside the range those markets actually
 * price at for a booking made four to six weeks out. Arrival times are derived
 * from departure + real block time, converted to destination local, which is
 * what the optimiser clusters on.
 *
 * Nothing here was fetched. No live search was run for any of it.
 */

/* mainline: carry-on included, first bag known.
 * wn:       Southwest, two free bags.
 * ulcc:     carry-on NOT included -- allInCost adds the assumed carry-on fee.
 * unknown:  fee data absent, which is the most common real case. */
var BAGS = {
  mainline: { carry_on_included: true, checked_first_price: 35, confidence: 'parsed' },
  wn: { carry_on_included: true, checked_first_price: 0, confidence: 'parsed' },
  ulcc: { carry_on_included: false, checked_first_price: 49, confidence: 'parsed' },
  unknown: { carry_on_included: null, checked_first_price: null, confidence: 'fee_unknown' }
};

/* o(from, to, 'YYYY-MM-DD HH:MM' depart, 'HH:MM' or '+1 HH:MM' arrive,
 *   blockMinutes, stops, price, airline, bagKind) */
function o(from, to, depart, arrive, dur, stops, price, airline, kind) {
  var day = depart.slice(0, 10);
  var arr;
  if (arrive.charAt(0) === '+') {
    var d = new Date(day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + (+arrive.charAt(1)));
    arr = d.toISOString().slice(0, 10) + ' ' + arrive.slice(3);
  } else arr = day + ' ' + arrive;
  return { price: price, depart: depart, arrive: arr, duration_minutes: dur,
           stops: stops, airlines: [].concat(airline), from: from, to: to,
           booking_token: null, extensions: [],
           bags: BAGS[kind || 'unknown'] };
}

/* ------------------------------------------------------------------ F1
 * Bachelor party of 6 bookings / 7 seats into Nashville, Fri 16 Apr 2027,
 * home Sun 18 Apr. The organiser wants everyone on the ground Friday
 * afternoon so the weekend starts at the same time.
 */
var F1 = {
  name: 'F1 — bachelor party, 6 bookings / 7 seats into BNA (Fri out, Sun back)',
  dest: 'BNA', dep: '2027-04-16', ret: '2027-04-18',
  parties: [
    { id: 'aus', name: 'Austin pair', seats: 2, airports: ['AUS'] },
    { id: 'chi', name: 'Chicago', seats: 1, airports: ['ORD', 'MDW'] },
    { id: 'nyc', name: 'New York', seats: 1, airports: ['LGA', 'EWR', 'JFK'] },
    { id: 'den', name: 'Denver', seats: 1, airports: ['DEN'] },
    { id: 'clt', name: 'Charlotte', seats: 1, airports: ['CLT'] },
    { id: 'lax', name: 'Los Angeles', seats: 1, airports: ['LAX'] }
  ],
  legs: {
    outbound: {
      /* AUS-BNA, both Central, 1h55 nonstop. */
      aus: [
        o('AUS', 'BNA', '2027-04-16 07:05', '09:00', 115, 0, 164, 'Southwest', 'wn'),
        o('AUS', 'BNA', '2027-04-16 12:20', '14:15', 115, 0, 189, 'Southwest', 'wn'),
        o('AUS', 'BNA', '2027-04-16 17:55', '19:50', 115, 0, 219, 'Southwest', 'wn'),
        o('AUS', 'BNA', '2027-04-16 14:40', '16:35', 115, 0, 79, 'Frontier', 'ulcc'),
        o('AUS', 'BNA', '2027-04-16 10:10', '14:35', 265, 1, 238, 'American', 'mainline'),
        o('AUS', 'BNA', '2027-04-16 06:00', '11:30', 330, 1, 212, 'Delta', 'mainline')
      ],
      /* ORD-BNA 1h35, MDW-BNA 1h30, both Central. */
      chi: [
        o('ORD', 'BNA', '2027-04-16 08:15', '09:50', 95, 0, 148, 'United', 'mainline'),
        o('MDW', 'BNA', '2027-04-16 09:45', '11:15', 90, 0, 129, 'Southwest', 'wn'),
        o('ORD', 'BNA', '2027-04-16 11:40', '13:15', 95, 0, 158, 'American', 'mainline'),
        o('MDW', 'BNA', '2027-04-16 13:25', '14:55', 90, 0, 149, 'Southwest', 'wn'),
        o('ORD', 'BNA', '2027-04-16 16:05', '17:40', 95, 0, 176, 'United', 'mainline'),
        o('ORD', 'BNA', '2027-04-16 07:00', '11:35', 275, 1, 205, 'Delta', 'mainline')
      ],
      /* LGA/JFK-BNA 2h40 block, EWR-BNA 2h45, Eastern to Central. */
      nyc: [
        o('LGA', 'BNA', '2027-04-16 08:00', '09:40', 160, 0, 179, 'Delta', 'mainline'),
        o('EWR', 'BNA', '2027-04-16 10:20', '12:05', 165, 0, 194, 'United', 'mainline'),
        o('LGA', 'BNA', '2027-04-16 12:30', '14:10', 160, 0, 208, 'American', 'mainline'),
        o('JFK', 'BNA', '2027-04-16 17:25', '19:05', 160, 0, 168, 'Delta', 'mainline'),
        o('EWR', 'BNA', '2027-04-16 06:00', '07:45', 165, 0, 89, 'Spirit', 'ulcc'),
        o('LGA', 'BNA', '2027-04-16 09:00', '13:20', 320, 1, 221, 'American', 'mainline')
      ],
      /* DEN-BNA 2h30 block, Mountain to Central. */
      den: [
        o('DEN', 'BNA', '2027-04-16 07:30', '11:00', 150, 0, 139, 'Southwest', 'wn'),
        o('DEN', 'BNA', '2027-04-16 10:45', '14:15', 150, 0, 184, 'United', 'mainline'),
        o('DEN', 'BNA', '2027-04-16 13:10', '16:40', 150, 0, 169, 'Southwest', 'wn'),
        o('DEN', 'BNA', '2027-04-16 06:05', '09:35', 150, 0, 69, 'Frontier', 'ulcc'),
        o('DEN', 'BNA', '2027-04-16 17:50', '21:20', 150, 0, 199, 'United', 'mainline')
      ],
      /* CLT-BNA 1h30 block, Eastern to Central. American fortress short hop. */
      clt: [
        o('CLT', 'BNA', '2027-04-16 08:45', '09:15', 90, 0, 268, 'American', 'mainline'),
        o('CLT', 'BNA', '2027-04-16 11:35', '12:05', 90, 0, 298, 'American', 'mainline'),
        o('CLT', 'BNA', '2027-04-16 14:50', '15:20', 90, 0, 284, 'American', 'mainline'),
        o('CLT', 'BNA', '2027-04-16 18:20', '18:50', 90, 0, 312, 'American', 'mainline'),
        o('CLT', 'BNA', '2027-04-16 10:05', '13:45', 280, 1, 236, 'Delta', 'mainline')
      ],
      /* LAX-BNA 3h55 block, Pacific to Central. */
      lax: [
        o('LAX', 'BNA', '2027-04-16 07:00', '12:55', 235, 0, 214, 'Southwest', 'wn'),
        o('LAX', 'BNA', '2027-04-16 08:30', '14:25', 235, 0, 238, 'Delta', 'mainline'),
        o('LAX', 'BNA', '2027-04-16 11:05', '17:00', 235, 0, 259, 'American', 'mainline'),
        o('LAX', 'BNA', '2027-04-16 14:40', '20:35', 235, 0, 198, 'Delta', 'mainline'),
        o('LAX', 'BNA', '2027-04-16 06:15', '14:10', 355, 1, 229, 'United', 'mainline'),
        o('LAX', 'BNA', '2027-04-16 09:30', '19:40', 610, 1, 118, 'Spirit', 'ulcc')
      ]
    },
    'return': {
      aus: [
        o('BNA', 'AUS', '2027-04-18 08:10', '10:10', 120, 0, 159, 'Southwest', 'wn'),
        o('BNA', 'AUS', '2027-04-18 13:45', '15:45', 120, 0, 184, 'Southwest', 'wn'),
        o('BNA', 'AUS', '2027-04-18 19:05', '21:05', 120, 0, 174, 'Southwest', 'wn'),
        o('BNA', 'AUS', '2027-04-18 16:20', '18:20', 120, 0, 84, 'Frontier', 'ulcc'),
        o('BNA', 'AUS', '2027-04-18 11:00', '15:55', 295, 1, 228, 'American', 'mainline')
      ],
      chi: [
        o('BNA', 'ORD', '2027-04-18 09:05', '10:45', 100, 0, 144, 'United', 'mainline'),
        o('BNA', 'MDW', '2027-04-18 12:30', '14:05', 95, 0, 134, 'Southwest', 'wn'),
        o('BNA', 'ORD', '2027-04-18 15:40', '17:20', 100, 0, 162, 'American', 'mainline'),
        o('BNA', 'MDW', '2027-04-18 18:55', '20:30', 95, 0, 154, 'Southwest', 'wn'),
        o('BNA', 'ORD', '2027-04-18 20:35', '22:15', 100, 0, 126, 'United', 'mainline')
      ],
      nyc: [
        o('BNA', 'LGA', '2027-04-18 07:40', '11:15', 155, 0, 184, 'Delta', 'mainline'),
        o('BNA', 'EWR', '2027-04-18 12:55', '16:35', 160, 0, 199, 'United', 'mainline'),
        o('BNA', 'LGA', '2027-04-18 16:10', '19:45', 155, 0, 214, 'American', 'mainline'),
        o('BNA', 'JFK', '2027-04-18 19:50', '23:25', 155, 0, 172, 'Delta', 'mainline'),
        o('BNA', 'EWR', '2027-04-18 06:20', '10:00', 160, 0, 94, 'Spirit', 'ulcc')
      ],
      den: [
        o('BNA', 'DEN', '2027-04-18 08:20', '09:50', 210, 0, 144, 'Southwest', 'wn'),
        o('BNA', 'DEN', '2027-04-18 12:40', '14:10', 210, 0, 189, 'United', 'mainline'),
        o('BNA', 'DEN', '2027-04-18 17:25', '18:55', 210, 0, 174, 'Southwest', 'wn'),
        o('BNA', 'DEN', '2027-04-18 06:30', '08:00', 210, 0, 74, 'Frontier', 'ulcc'),
        o('BNA', 'DEN', '2027-04-18 20:10', '21:40', 210, 0, 204, 'United', 'mainline')
      ],
      clt: [
        o('BNA', 'CLT', '2027-04-18 09:30', '11:55', 85, 0, 274, 'American', 'mainline'),
        o('BNA', 'CLT', '2027-04-18 13:05', '15:30', 85, 0, 302, 'American', 'mainline'),
        o('BNA', 'CLT', '2027-04-18 16:45', '19:10', 85, 0, 288, 'American', 'mainline'),
        o('BNA', 'CLT', '2027-04-18 19:55', '22:20', 85, 0, 318, 'American', 'mainline'),
        o('BNA', 'CLT', '2027-04-18 11:20', '16:20', 240, 1, 242, 'Delta', 'mainline')
      ],
      lax: [
        o('BNA', 'LAX', '2027-04-18 08:00', '10:05', 245, 0, 219, 'Southwest', 'wn'),
        o('BNA', 'LAX', '2027-04-18 11:40', '13:45', 245, 0, 244, 'Delta', 'mainline'),
        o('BNA', 'LAX', '2027-04-18 15:25', '17:30', 245, 0, 264, 'American', 'mainline'),
        o('BNA', 'LAX', '2027-04-18 19:00', '21:05', 245, 0, 203, 'Delta', 'mainline'),
        o('BNA', 'LAX', '2027-04-18 07:10', '13:20', 370, 1, 234, 'United', 'mainline')
      ]
    }
  }
};

/* ------------------------------------------------------------------ F2
 * Three friends, two coasts, into Denver. Thu 10 Jun 2027 out, Sun 13 back.
 * The cheapest flights on this trip are a 23:45 arrival and a 01:20 arrival,
 * so this is the fixture that asks whether the app will sell closeness.
 */
var F2 = {
  name: 'F2 — 3 friends coast-to-coast into DEN (Thu out, Sun back)',
  dest: 'DEN', dep: '2027-06-10', ret: '2027-06-13',
  parties: [
    { id: 'sf', name: 'Bay Area', seats: 1, airports: ['SFO', 'OAK', 'SJC'] },
    { id: 'bos', name: 'Boston', seats: 1, airports: ['BOS'] },
    { id: 'sea', name: 'Seattle', seats: 1, airports: ['SEA'] }
  ],
  legs: {
    outbound: {
      /* SFO/OAK/SJC-DEN 2h35 block, Pacific to Mountain. */
      sf: [
        o('SFO', 'DEN', '2027-06-10 06:00', '09:35', 155, 0, 148, 'United', 'mainline'),
        o('OAK', 'DEN', '2027-06-10 07:10', '10:45', 155, 0, 139, 'Southwest', 'wn'),
        o('SFO', 'DEN', '2027-06-10 10:25', '14:00', 155, 0, 178, 'United', 'mainline'),
        o('SJC', 'DEN', '2027-06-10 11:50', '15:25', 155, 0, 159, 'Southwest', 'wn'),
        o('SFO', 'DEN', '2027-06-10 13:40', '17:15', 155, 0, 169, 'Southwest', 'wn'),
        o('SFO', 'DEN', '2027-06-10 20:10', '23:45', 155, 0, 59, 'Frontier', 'ulcc')
      ],
      /* BOS-DEN 4h40 block, Eastern to Mountain. */
      bos: [
        o('BOS', 'DEN', '2027-06-10 06:00', '08:40', 280, 0, 189, 'United', 'mainline'),
        o('BOS', 'DEN', '2027-06-10 07:45', '10:25', 280, 0, 219, 'United', 'mainline'),
        o('BOS', 'DEN', '2027-06-10 10:10', '12:50', 280, 0, 239, 'Southwest', 'wn'),
        o('BOS', 'DEN', '2027-06-10 13:30', '16:10', 280, 0, 259, 'Delta', 'mainline'),
        o('BOS', 'DEN', '2027-06-10 17:40', '20:20', 280, 0, 199, 'JetBlue', 'mainline')
      ],
      /* SEA-DEN 2h50 block, Pacific to Mountain. */
      sea: [
        o('SEA', 'DEN', '2027-06-10 06:05', '09:55', 170, 0, 148, 'Southwest', 'wn'),
        o('SEA', 'DEN', '2027-06-10 07:00', '10:50', 170, 0, 158, 'Alaska', 'mainline'),
        o('SEA', 'DEN', '2027-06-10 11:15', '15:05', 170, 0, 178, 'United', 'mainline'),
        o('SEA', 'DEN', '2027-06-10 14:20', '18:10', 170, 0, 168, 'Alaska', 'mainline'),
        o('SEA', 'DEN', '2027-06-10 21:30', '+1 01:20', 170, 0, 69, 'Frontier', 'ulcc')
      ]
    },
    'return': {
      sf: [
        o('DEN', 'SFO', '2027-06-13 08:05', '09:50', 165, 0, 154, 'United', 'mainline'),
        o('DEN', 'OAK', '2027-06-13 12:15', '14:00', 165, 0, 144, 'Southwest', 'wn'),
        o('DEN', 'SFO', '2027-06-13 16:40', '18:25', 165, 0, 184, 'United', 'mainline'),
        o('DEN', 'SJC', '2027-06-13 19:30', '21:15', 165, 0, 164, 'Southwest', 'wn'),
        o('DEN', 'SFO', '2027-06-13 21:50', '23:35', 165, 0, 64, 'Frontier', 'ulcc')
      ],
      bos: [
        o('DEN', 'BOS', '2027-06-13 07:30', '13:15', 225, 0, 199, 'United', 'mainline'),
        o('DEN', 'BOS', '2027-06-13 10:55', '16:40', 225, 0, 229, 'Southwest', 'wn'),
        o('DEN', 'BOS', '2027-06-13 14:20', '20:05', 225, 0, 249, 'Delta', 'mainline'),
        o('DEN', 'BOS', '2027-06-13 18:10', '23:55', 225, 0, 209, 'JetBlue', 'mainline')
      ],
      sea: [
        o('DEN', 'SEA', '2027-06-13 08:40', '10:25', 165, 0, 154, 'Southwest', 'wn'),
        o('DEN', 'SEA', '2027-06-13 12:05', '13:50', 165, 0, 168, 'Alaska', 'mainline'),
        o('DEN', 'SEA', '2027-06-13 16:35', '18:20', 165, 0, 178, 'United', 'mainline'),
        o('DEN', 'SEA', '2027-06-13 20:45', '22:30', 165, 0, 74, 'Frontier', 'ulcc')
      ]
    }
  }
};

/* ------------------------------------------------------------------ F3
 * Wedding in Madison. Five bookings, Fri 17 Sep 2027. MSN is a thin airport:
 * Charleston has exactly two usable itineraries a day and Seattle has no
 * nonstop at all, so the two of them decide the whole window.
 */
var F3 = {
  name: 'F3 — wedding, 5 bookings into MSN, one party with two flights a day',
  dest: 'MSN', dep: '2027-09-17', ret: '2027-09-19',
  parties: [
    { id: 'chi', name: 'Chicago', seats: 1, airports: ['ORD'] },
    { id: 'den', name: 'Denver', seats: 1, airports: ['DEN'] },
    { id: 'atl', name: 'Atlanta', seats: 2, airports: ['ATL'] },
    { id: 'sea', name: 'Seattle', seats: 1, airports: ['SEA'] },
    { id: 'chs', name: 'Charleston', seats: 1, airports: ['CHS'] }
  ],
  legs: {
    outbound: {
      /* ORD-MSN 1h00 nonstop, both Central. */
      chi: [
        o('ORD', 'MSN', '2027-09-17 08:10', '09:10', 60, 0, 138, 'American', 'mainline'),
        o('ORD', 'MSN', '2027-09-17 11:25', '12:25', 60, 0, 148, 'United', 'mainline'),
        o('ORD', 'MSN', '2027-09-17 14:40', '15:40', 60, 0, 158, 'American', 'mainline'),
        o('ORD', 'MSN', '2027-09-17 17:50', '18:50', 60, 0, 168, 'United', 'mainline'),
        o('ORD', 'MSN', '2027-09-17 20:40', '21:40', 60, 0, 128, 'United', 'mainline')
      ],
      /* DEN-MSN 2h05 block, Mountain to Central. */
      den: [
        o('DEN', 'MSN', '2027-09-17 09:15', '12:20', 125, 0, 218, 'United', 'mainline'),
        o('DEN', 'MSN', '2027-09-17 16:40', '19:45', 125, 0, 238, 'United', 'mainline'),
        o('DEN', 'MSN', '2027-09-17 06:30', '09:35', 125, 0, 79, 'Frontier', 'ulcc'),
        o('DEN', 'MSN', '2027-09-17 07:00', '12:25', 325, 1, 258, 'United', 'mainline')
      ],
      /* ATL-MSN 2h05 block, Eastern to Central. */
      atl: [
        o('ATL', 'MSN', '2027-09-17 08:25', '09:30', 125, 0, 189, 'Delta', 'mainline'),
        o('ATL', 'MSN', '2027-09-17 12:10', '13:15', 125, 0, 209, 'Delta', 'mainline'),
        o('ATL', 'MSN', '2027-09-17 18:35', '19:40', 125, 0, 179, 'Delta', 'mainline'),
        o('ATL', 'MSN', '2027-09-17 09:40', '14:15', 335, 1, 228, 'American', 'mainline')
      ],
      /* SEA-MSN: no nonstop. One stop via MSP or ORD, Pacific to Central. */
      sea: [
        o('SEA', 'MSN', '2027-09-17 06:15', '14:25', 370, 1, 338, 'Alaska', 'mainline'),
        o('SEA', 'MSN', '2027-09-17 07:00', '15:05', 365, 1, 288, 'Delta', 'mainline'),
        o('SEA', 'MSN', '2027-09-17 08:30', '16:40', 370, 1, 318, 'United', 'mainline'),
        o('SEA', 'MSN', '2027-09-17 13:15', '21:20', 365, 1, 268, 'Delta', 'mainline')
      ],
      /* CHS-MSN: no nonstop, two usable itineraries a day. Eastern to Central. */
      chs: [
        o('CHS', 'MSN', '2027-09-17 06:00', '10:35', 335, 1, 298, 'Delta', 'mainline'),
        o('CHS', 'MSN', '2027-09-17 14:25', '19:10', 345, 1, 328, 'American', 'mainline')
      ]
    },
    'return': {
      chi: [
        o('MSN', 'ORD', '2027-09-19 10:05', '11:05', 60, 0, 134, 'American', 'mainline'),
        o('MSN', 'ORD', '2027-09-19 13:20', '14:20', 60, 0, 144, 'United', 'mainline'),
        o('MSN', 'ORD', '2027-09-19 17:35', '18:35', 60, 0, 154, 'American', 'mainline')
      ],
      den: [
        o('MSN', 'DEN', '2027-09-19 13:05', '14:15', 130, 0, 214, 'United', 'mainline'),
        o('MSN', 'DEN', '2027-09-19 20:20', '21:30', 130, 0, 234, 'United', 'mainline'),
        o('MSN', 'DEN', '2027-09-19 10:15', '11:25', 130, 0, 84, 'Frontier', 'ulcc')
      ],
      atl: [
        o('MSN', 'ATL', '2027-09-19 11:00', '14:05', 125, 0, 184, 'Delta', 'mainline'),
        o('MSN', 'ATL', '2027-09-19 15:40', '18:45', 125, 0, 204, 'Delta', 'mainline'),
        o('MSN', 'ATL', '2027-09-19 19:50', '22:55', 125, 0, 174, 'Delta', 'mainline')
      ],
      sea: [
        o('MSN', 'SEA', '2027-09-19 06:10', '11:20', 370, 1, 293, 'Delta', 'mainline'),
        o('MSN', 'SEA', '2027-09-19 12:40', '17:50', 370, 1, 273, 'Delta', 'mainline'),
        o('MSN', 'SEA', '2027-09-19 15:05', '20:15', 370, 1, 323, 'United', 'mainline')
      ],
      chs: [
        o('MSN', 'CHS', '2027-09-19 06:45', '13:20', 335, 1, 303, 'Delta', 'mainline'),
        o('MSN', 'CHS', '2027-09-19 13:50', '20:35', 345, 1, 333, 'American', 'mainline')
      ]
    }
  }
};

/* ------------------------------------------------------------------ F4
 * Four into Austin. The Greenville party has added Charlotte to their own
 * party because they will drive two hours each way for a nonstop -- which the
 * app has no way to know costs them anything.
 */
var F4 = {
  name: 'F4 — 4 into AUS, one party 2h drive from the hub (GSP + CLT)',
  dest: 'AUS', dep: '2027-03-11', ret: '2027-03-15',
  parties: [
    { id: 'gsp', name: 'Greenville', seats: 1, airports: ['GSP', 'CLT'] },
    { id: 'nyc', name: 'New York', seats: 1, airports: ['LGA', 'EWR'] },
    { id: 'chi', name: 'Chicago', seats: 1, airports: ['ORD', 'MDW'] },
    { id: 'sea', name: 'Seattle', seats: 1, airports: ['SEA'] }
  ],
  legs: {
    outbound: {
      /* CLT-AUS 2h55 nonstop (Eastern to Central). GSP-AUS one stop only. */
      gsp: [
        o('CLT', 'AUS', '2027-03-11 09:00', '10:55', 175, 0, 178, 'American', 'mainline'),
        o('CLT', 'AUS', '2027-03-11 13:35', '15:30', 175, 0, 198, 'American', 'mainline'),
        o('CLT', 'AUS', '2027-03-11 18:10', '20:05', 175, 0, 188, 'American', 'mainline'),
        o('GSP', 'AUS', '2027-03-11 06:20', '10:25', 305, 1, 248, 'American', 'mainline'),
        o('GSP', 'AUS', '2027-03-11 11:45', '16:15', 330, 1, 268, 'Delta', 'mainline'),
        o('GSP', 'AUS', '2027-03-11 16:05', '20:40', 335, 1, 258, 'American', 'mainline')
      ],
      /* LGA-AUS 4h10 block, EWR-AUS 4h15, Eastern to Central. */
      nyc: [
        o('LGA', 'AUS', '2027-03-11 07:30', '10:40', 250, 0, 198, 'American', 'mainline'),
        o('EWR', 'AUS', '2027-03-11 09:50', '13:05', 255, 0, 214, 'United', 'mainline'),
        o('LGA', 'AUS', '2027-03-11 14:15', '17:25', 250, 0, 228, 'Delta', 'mainline'),
        o('EWR', 'AUS', '2027-03-11 18:40', '21:55', 255, 0, 184, 'United', 'mainline'),
        o('LGA', 'AUS', '2027-03-11 06:00', '12:20', 380, 1, 164, 'American', 'mainline')
      ],
      /* ORD-AUS 2h45, MDW-AUS 2h45, both Central. */
      chi: [
        o('ORD', 'AUS', '2027-03-11 08:20', '11:05', 165, 0, 158, 'United', 'mainline'),
        o('MDW', 'AUS', '2027-03-11 10:45', '13:30', 165, 0, 148, 'Southwest', 'wn'),
        o('ORD', 'AUS', '2027-03-11 13:50', '16:35', 165, 0, 168, 'American', 'mainline'),
        o('MDW', 'AUS', '2027-03-11 16:25', '19:10', 165, 0, 158, 'Southwest', 'wn'),
        o('ORD', 'AUS', '2027-03-11 19:40', '22:25', 165, 0, 138, 'United', 'mainline')
      ],
      /* SEA-AUS 4h15 block, Pacific to Central. */
      sea: [
        o('SEA', 'AUS', '2027-03-11 07:15', '13:30', 255, 0, 228, 'Alaska', 'mainline'),
        o('SEA', 'AUS', '2027-03-11 10:40', '16:55', 255, 0, 248, 'Alaska', 'mainline'),
        o('SEA', 'AUS', '2027-03-11 22:05', '+1 04:20', 255, 0, 188, 'Alaska', 'mainline'),
        o('SEA', 'AUS', '2027-03-11 06:00', '14:45', 405, 1, 208, 'United', 'mainline'),
        o('SEA', 'AUS', '2027-03-11 12:20', '21:10', 410, 1, 198, 'American', 'mainline')
      ]
    },
    'return': {
      gsp: [
        o('AUS', 'CLT', '2027-03-15 07:40', '11:25', 165, 0, 184, 'American', 'mainline'),
        o('AUS', 'CLT', '2027-03-15 12:50', '16:35', 165, 0, 204, 'American', 'mainline'),
        o('AUS', 'CLT', '2027-03-15 17:30', '21:15', 165, 0, 194, 'American', 'mainline'),
        o('AUS', 'GSP', '2027-03-15 06:30', '12:10', 280, 1, 254, 'American', 'mainline'),
        o('AUS', 'GSP', '2027-03-15 13:15', '19:20', 305, 1, 274, 'Delta', 'mainline')
      ],
      nyc: [
        o('AUS', 'LGA', '2027-03-15 07:00', '11:50', 230, 0, 204, 'American', 'mainline'),
        o('AUS', 'EWR', '2027-03-15 11:30', '16:25', 235, 0, 219, 'United', 'mainline'),
        o('AUS', 'LGA', '2027-03-15 16:05', '20:55', 230, 0, 234, 'Delta', 'mainline'),
        o('AUS', 'EWR', '2027-03-15 19:20', '+1 00:15', 235, 0, 189, 'United', 'mainline')
      ],
      chi: [
        o('AUS', 'ORD', '2027-03-15 08:00', '10:25', 145, 0, 162, 'United', 'mainline'),
        o('AUS', 'MDW', '2027-03-15 12:10', '14:35', 145, 0, 152, 'Southwest', 'wn'),
        o('AUS', 'ORD', '2027-03-15 16:30', '18:55', 145, 0, 172, 'American', 'mainline'),
        o('AUS', 'MDW', '2027-03-15 19:45', '22:10', 145, 0, 142, 'Southwest', 'wn')
      ],
      sea: [
        o('AUS', 'SEA', '2027-03-15 08:30', '11:05', 275, 0, 232, 'Alaska', 'mainline'),
        o('AUS', 'SEA', '2027-03-15 14:45', '17:20', 275, 0, 252, 'Alaska', 'mainline'),
        o('AUS', 'SEA', '2027-03-15 06:15', '11:40', 385, 1, 212, 'United', 'mainline'),
        o('AUS', 'SEA', '2027-03-15 17:50', '23:15', 385, 1, 202, 'American', 'mainline')
      ]
    }
  }
};

module.exports = { o: o, BAGS: BAGS, F1: F1, F2: F2, F3: F3, F4: F4 };
