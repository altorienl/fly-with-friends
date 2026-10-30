/* Airport lookup for Fly with Friends.
 *
 * A curated list, not an exhaustive one: every airport a group of friends is
 * realistically converging on or departing from, which is major hubs plus the
 * leisure destinations people actually pick. Typing a free-text code was the
 * old failure mode -- "SAN" when you meant "SJD" returns a real but wrong
 * answer, and nothing downstream can detect it.
 *
 * Format is positional to keep the payload small: [iata, city, airport, country]
 */
(function (root) {
  'use strict';

  var A = [
    // --- United States
    ['ATL','Atlanta','Hartsfield-Jackson','US'],['LAX','Los Angeles','Los Angeles Intl','US'],
    ['ORD','Chicago','O’Hare','US'],['DFW','Dallas','Dallas/Fort Worth','US'],
    ['DEN','Denver','Denver Intl','US'],['JFK','New York','John F. Kennedy','US'],
    ['SFO','San Francisco','San Francisco Intl','US'],['SEA','Seattle','Seattle-Tacoma','US'],
    ['LAS','Las Vegas','Harry Reid','US'],['MCO','Orlando','Orlando Intl','US'],
    ['EWR','Newark','Newark Liberty','US'],['CLT','Charlotte','Charlotte Douglas','US'],
    ['PHX','Phoenix','Sky Harbor','US'],['IAH','Houston','George Bush','US'],
    ['MIA','Miami','Miami Intl','US'],['BOS','Boston','Logan','US'],
    ['MSP','Minneapolis','Minneapolis-St Paul','US'],['FLL','Fort Lauderdale','Hollywood Intl','US'],
    ['DTW','Detroit','Detroit Metro','US'],['PHL','Philadelphia','Philadelphia Intl','US'],
    ['LGA','New York','LaGuardia','US'],['BWI','Baltimore','Thurgood Marshall','US'],
    ['SLC','Salt Lake City','Salt Lake City Intl','US'],['DCA','Washington','Reagan National','US'],
    ['IAD','Washington','Dulles','US'],['SAN','San Diego','San Diego Intl','US'],
    ['MDW','Chicago','Midway','US'],['HOU','Houston','William P. Hobby','US'],
    ['DAL','Dallas','Love Field','US'],['LGB','Long Beach','Long Beach','US'],['TPA','Tampa','Tampa Intl','US'],
    ['PDX','Portland','Portland Intl','US'],['HNL','Honolulu','Daniel K. Inouye','US'],
    ['STL','St Louis','Lambert','US'],['AUS','Austin','Austin-Bergstrom','US'],
    ['OAK','Oakland','Oakland Intl','US'],['MSY','New Orleans','Louis Armstrong','US'],
    ['RDU','Raleigh','Raleigh-Durham','US'],['SJC','San Jose','Norman Y. Mineta','US'],
    ['SMF','Sacramento','Sacramento Intl','US'],['SNA','Santa Ana','John Wayne','US'],
    ['MCI','Kansas City','Kansas City Intl','US'],['PIT','Pittsburgh','Pittsburgh Intl','US'],
    ['CLE','Cleveland','Hopkins','US'],['IND','Indianapolis','Indianapolis Intl','US'],
    ['CVG','Cincinnati','Cincinnati/N. Kentucky','US'],
    ['BNA','Nashville','Nashville Intl','US'],['CMH','Columbus','John Glenn','US'],
    ['PBI','West Palm Beach','Palm Beach Intl','US'],['RSW','Fort Myers','SW Florida','US'],
    ['JAX','Jacksonville','Jacksonville Intl','US'],['ONT','Ontario','Ontario Intl','US'],
    ['BUR','Burbank','Hollywood Burbank','US'],['OGG','Maui','Kahului','US'],
    ['KOA','Kona','Ellison Onizuka','US'],['LIH','Kauai','Lihue','US'],
    ['ANC','Anchorage','Ted Stevens','US'],['ABQ','Albuquerque','Sunport','US'],
    ['OMA','Omaha','Eppley','US'],['BOI','Boise','Boise Airport','US'],
    ['TUS','Tucson','Tucson Intl','US'],['RNO','Reno','Reno-Tahoe','US'],
    ['ELP','El Paso','El Paso Intl','US'],['OKC','Oklahoma City','Will Rogers','US'],
    ['TUL','Tulsa','Tulsa Intl','US'],['MKE','Milwaukee','Mitchell','US'],
    ['BUF','Buffalo','Niagara','US'],['ALB','Albany','Albany Intl','US'],
    ['PVD','Providence','T. F. Green','US'],['BDL','Hartford','Bradley','US'],
    ['ROC','Rochester','Greater Rochester','US'],['SYR','Syracuse','Hancock','US'],
    ['GRR','Grand Rapids','Gerald R. Ford','US'],['DSM','Des Moines','Des Moines Intl','US'],
    ['CHS','Charleston','Charleston Intl','US'],['SAV','Savannah','Savannah/Hilton Head','US'],
    ['GSP','Greenville','Greenville-Spartanburg','US'],['MEM','Memphis','Memphis Intl','US'],
    ['LIT','Little Rock','Clinton National','US'],['RIC','Richmond','Richmond Intl','US'],
    ['ORF','Norfolk','Norfolk Intl','US'],['MYR','Myrtle Beach','Myrtle Beach Intl','US'],
    ['SRQ','Sarasota','Bradenton','US'],['PSP','Palm Springs','Palm Springs Intl','US'],
    ['FAT','Fresno','Fresno Yosemite','US'],['GEG','Spokane','Spokane Intl','US'],
    ['COS','Colorado Springs','Colorado Springs','US'],['ICT','Wichita','Eisenhower','US'],
    ['MSN','Madison','Dane County','US'],['FAI','Fairbanks','Fairbanks Intl','US'],

    // --- Canada
    ['YYZ','Toronto','Pearson','CA'],['YVR','Vancouver','Vancouver Intl','CA'],
    ['YUL','Montreal','Trudeau','CA'],['YYC','Calgary','Calgary Intl','CA'],
    ['YOW','Ottawa','Macdonald-Cartier','CA'],['YEG','Edmonton','Edmonton Intl','CA'],
    ['YHZ','Halifax','Stanfield','CA'],['YWG','Winnipeg','Richardson','CA'],

    // --- Mexico, Central America, Caribbean
    ['SJD','Los Cabos','Los Cabos Intl','MX'],['CUN','Cancun','Cancun Intl','MX'],
    ['MEX','Mexico City','Benito Juarez','MX'],['PVR','Puerto Vallarta','Lic. Gustavo Diaz Ordaz','MX'],
    ['GDL','Guadalajara','Miguel Hidalgo','MX'],['MTY','Monterrey','Mariano Escobedo','MX'],
    ['TIJ','Tijuana','Tijuana Intl','MX'],['ZIH','Ixtapa','Zihuatanejo','MX'],
    ['HUX','Huatulco','Bahias de Huatulco','MX'],['MID','Merida','Merida Intl','MX'],
    ['PUJ','Punta Cana','Punta Cana Intl','DO'],['SDQ','Santo Domingo','Las Americas','DO'],
    ['MBJ','Montego Bay','Sangster','JM'],['KIN','Kingston','Norman Manley','JM'],
    ['NAS','Nassau','Lynden Pindling','BS'],['AUA','Aruba','Queen Beatrix','AW'],
    ['SJU','San Juan','Luis Munoz Marin','PR'],['BGI','Barbados','Grantley Adams','BB'],
    ['CUR','Curacao','Hato','CW'],['SXM','St Maarten','Princess Juliana','SX'],
    ['LIR','Liberia','Guanacaste','CR'],['SJO','San Jose','Juan Santamaria','CR'],
    ['PTY','Panama City','Tocumen','PA'],['BZE','Belize City','Philip Goldson','BZ'],
    ['GUA','Guatemala City','La Aurora','GT'],['HAV','Havana','Jose Marti','CU'],

    // --- South America
    ['GRU','Sao Paulo','Guarulhos','BR'],['GIG','Rio de Janeiro','Galeao','BR'],
    ['EZE','Buenos Aires','Ezeiza','AR'],['SCL','Santiago','Arturo Merino Benitez','CL'],
    ['BOG','Bogota','El Dorado','CO'],['MDE','Medellin','Jose Maria Cordova','CO'],
    ['LIM','Lima','Jorge Chavez','PE'],['UIO','Quito','Mariscal Sucre','EC'],
    ['MVD','Montevideo','Carrasco','UY'],['CCS','Caracas','Simon Bolivar','VE'],
    ['CUZ','Cusco','Alejandro Velasco Astete','PE'],['ASU','Asuncion','Silvio Pettirossi','PY'],

    // --- United Kingdom and Ireland
    ['LHR','London','Heathrow','GB'],['LGW','London','Gatwick','GB'],
    ['STN','London','Stansted','GB'],['LTN','London','Luton','GB'],
    ['LCY','London','City','GB'],['MAN','Manchester','Manchester','GB'],
    ['EDI','Edinburgh','Edinburgh','GB'],['GLA','Glasgow','Glasgow','GB'],
    ['BHX','Birmingham','Birmingham','GB'],['BRS','Bristol','Bristol','GB'],
    ['NCL','Newcastle','Newcastle','GB'],['BFS','Belfast','Belfast Intl','GB'],
    ['DUB','Dublin','Dublin','IE'],['SNN','Shannon','Shannon','IE'],
    ['ORK','Cork','Cork','IE'],

    // --- Europe
    ['CDG','Paris','Charles de Gaulle','FR'],['ORY','Paris','Orly','FR'],
    ['AMS','Amsterdam','Schiphol','NL'],['FRA','Frankfurt','Frankfurt','DE'],
    ['MUC','Munich','Munich','DE'],['BER','Berlin','Brandenburg','DE'],
    ['DUS','Dusseldorf','Dusseldorf','DE'],['HAM','Hamburg','Hamburg','DE'],
    ['MAD','Madrid','Barajas','ES'],['BCN','Barcelona','El Prat','ES'],
    ['AGP','Malaga','Malaga','ES'],['PMI','Palma','Palma de Mallorca','ES'],
    ['VLC','Valencia','Valencia','ES'],['SVQ','Seville','Seville','ES'],
    ['IBZ','Ibiza','Ibiza','ES'],['LIS','Lisbon','Humberto Delgado','PT'],
    ['OPO','Porto','Francisco Sa Carneiro','PT'],['FAO','Faro','Faro','PT'],
    ['FCO','Rome','Fiumicino','IT'],['MXP','Milan','Malpensa','IT'],
    ['LIN','Milan','Linate','IT'],['VCE','Venice','Marco Polo','IT'],
    ['NAP','Naples','Capodichino','IT'],['BLQ','Bologna','Guglielmo Marconi','IT'],
    ['FLR','Florence','Peretola','IT'],['CTA','Catania','Fontanarossa','IT'],
    ['PMO','Palermo','Falcone Borsellino','IT'],['ZRH','Zurich','Zurich','CH'],
    ['GVA','Geneva','Geneva','CH'],['VIE','Vienna','Vienna','AT'],
    ['BRU','Brussels','Brussels','BE'],['CPH','Copenhagen','Kastrup','DK'],
    ['ARN','Stockholm','Arlanda','SE'],['OSL','Oslo','Gardermoen','NO'],
    ['HEL','Helsinki','Vantaa','FI'],['KEF','Reykjavik','Keflavik','IS'],
    ['WAW','Warsaw','Chopin','PL'],['KRK','Krakow','John Paul II','PL'],
    ['GDN','Gdansk','Lech Walesa','PL'],['WRO','Wroclaw','Copernicus','PL'],
    ['RZE','Rzeszow','Jasionka','PL'],['PRG','Prague','Vaclav Havel','CZ'],
    ['BUD','Budapest','Ferenc Liszt','HU'],['OTP','Bucharest','Henri Coanda','RO'],
    ['SOF','Sofia','Sofia','BG'],['ATH','Athens','Eleftherios Venizelos','GR'],
    ['SKG','Thessaloniki','Macedonia','GR'],['JTR','Santorini','Santorini','GR'],
    ['JMK','Mykonos','Mykonos','GR'],['HER','Crete','Heraklion','GR'],
    ['IST','Istanbul','Istanbul','TR'],['SAW','Istanbul','Sabiha Gokcen','TR'],
    ['AYT','Antalya','Antalya','TR'],['ZAG','Zagreb','Franjo Tudman','HR'],
    ['SPU','Split','Split','HR'],['DBV','Dubrovnik','Dubrovnik','HR'],
    ['LJU','Ljubljana','Joze Pucnik','SI'],['BEG','Belgrade','Nikola Tesla','RS'],
    ['TLL','Tallinn','Lennart Meri','EE'],['RIX','Riga','Riga','LV'],
    ['VNO','Vilnius','Vilnius','LT'],['KIV','Chisinau','Chisinau','MD'],
    ['TBS','Tbilisi','Tbilisi','GE'],['EVN','Yerevan','Zvartnots','AM'],
    ['MLA','Malta','Malta','MT'],['LCA','Larnaca','Larnaca','CY'],

    // --- Middle East and Africa
    ['DXB','Dubai','Dubai Intl','AE'],['AUH','Abu Dhabi','Zayed Intl','AE'],
    ['DOH','Doha','Hamad Intl','QA'],['RUH','Riyadh','King Khalid','SA'],
    ['JED','Jeddah','King Abdulaziz','SA'],['TLV','Tel Aviv','Ben Gurion','IL'],
    ['AMM','Amman','Queen Alia','JO'],['KWI','Kuwait City','Kuwait Intl','KW'],
    ['BAH','Manama','Bahrain Intl','BH'],['MCT','Muscat','Muscat Intl','OM'],
    ['CAI','Cairo','Cairo Intl','EG'],['HRG','Hurghada','Hurghada','EG'],
    ['CMN','Casablanca','Mohammed V','MA'],['RAK','Marrakesh','Menara','MA'],
    ['TUN','Tunis','Carthage','TN'],['JNB','Johannesburg','O. R. Tambo','ZA'],
    ['CPT','Cape Town','Cape Town Intl','ZA'],['NBO','Nairobi','Jomo Kenyatta','KE'],
    ['ADD','Addis Ababa','Bole','ET'],['LOS','Lagos','Murtala Muhammed','NG'],
    ['ACC','Accra','Kotoka','GH'],['DAR','Dar es Salaam','Julius Nyerere','TZ'],
    ['MRU','Mauritius','Sir Seewoosagur Ramgoolam','MU'],['SEZ','Seychelles','Seychelles Intl','SC'],

    // --- Asia
    ['HND','Tokyo','Haneda','JP'],['NRT','Tokyo','Narita','JP'],
    ['KIX','Osaka','Kansai','JP'],['CTS','Sapporo','New Chitose','JP'],
    ['FUK','Fukuoka','Fukuoka','JP'],['ICN','Seoul','Incheon','KR'],
    ['GMP','Seoul','Gimpo','KR'],['PEK','Beijing','Capital','CN'],
    ['PKX','Beijing','Daxing','CN'],['PVG','Shanghai','Pudong','CN'],
    ['SHA','Shanghai','Hongqiao','CN'],['CAN','Guangzhou','Baiyun','CN'],
    ['SZX','Shenzhen','Bao’an','CN'],['CTU','Chengdu','Tianfu','CN'],
    ['HKG','Hong Kong','Hong Kong Intl','HK'],['TPE','Taipei','Taoyuan','TW'],
    ['SIN','Singapore','Changi','SG'],['BKK','Bangkok','Suvarnabhumi','TH'],
    ['DMK','Bangkok','Don Mueang','TH'],['HKT','Phuket','Phuket','TH'],
    ['CNX','Chiang Mai','Chiang Mai','TH'],['USM','Koh Samui','Samui','TH'],
    ['KUL','Kuala Lumpur','KLIA','MY'],['CGK','Jakarta','Soekarno-Hatta','ID'],
    ['DPS','Bali','Ngurah Rai','ID'],['MNL','Manila','Ninoy Aquino','PH'],
    ['CEB','Cebu','Mactan-Cebu','PH'],['SGN','Ho Chi Minh City','Tan Son Nhat','VN'],
    ['HAN','Hanoi','Noi Bai','VN'],['DAD','Da Nang','Da Nang','VN'],
    ['REP','Siem Reap','Angkor','KH'],['PNH','Phnom Penh','Phnom Penh','KH'],
    ['DEL','Delhi','Indira Gandhi','IN'],['BOM','Mumbai','Chhatrapati Shivaji','IN'],
    ['BLR','Bengaluru','Kempegowda','IN'],['MAA','Chennai','Chennai Intl','IN'],
    ['HYD','Hyderabad','Rajiv Gandhi','IN'],['CCU','Kolkata','Netaji Subhas','IN'],
    ['COK','Kochi','Cochin','IN'],['GOI','Goa','Dabolim','IN'],
    ['CMB','Colombo','Bandaranaike','LK'],['MLE','Maldives','Velana','MV'],
    ['KTM','Kathmandu','Tribhuvan','NP'],['DAC','Dhaka','Shahjalal','BD'],
    ['ISB','Islamabad','Islamabad Intl','PK'],['KHI','Karachi','Jinnah','PK'],
    ['LHE','Lahore','Allama Iqbal','PK'],['TAS','Tashkent','Islam Karimov','UZ'],
    ['ALA','Almaty','Almaty','KZ'],

    // --- Oceania
    ['SYD','Sydney','Kingsford Smith','AU'],['MEL','Melbourne','Tullamarine','AU'],
    ['BNE','Brisbane','Brisbane','AU'],['PER','Perth','Perth','AU'],
    ['ADL','Adelaide','Adelaide','AU'],['OOL','Gold Coast','Gold Coast','AU'],
    ['CNS','Cairns','Cairns','AU'],['AKL','Auckland','Auckland','NZ'],
    ['CHC','Christchurch','Christchurch','NZ'],['WLG','Wellington','Wellington','NZ'],
    ['ZQN','Queenstown','Queenstown','NZ'],['NAN','Nadi','Nadi','FJ'],
    ['PPT','Tahiti','Faa’a','PF'],['GUM','Guam','Antonio B. Won Pat','GU']
  ];

  /* Airports that exist, are what people type, and have no commercial service.
   * Returning "no match" for Kyiv is unhelpful; saying why, and where people
   * actually fly from instead, is what a friend who travels would tell you. */
  var CLOSED = [
    ['KBP','Kyiv','Boryspil','UA','Ukrainian airspace has been closed to civil aviation since February 2022.','KRK,WAW,RZE,KIV'],
    ['IEV','Kyiv','Zhuliany','UA','Ukrainian airspace has been closed to civil aviation since February 2022.','KRK,WAW,RZE,KIV'],
    ['LWO','Lviv','Danylo Halytskyi','UA','Ukrainian airspace has been closed to civil aviation since February 2022.','KRK,RZE,WAW'],
    ['ODS','Odesa','Odesa Intl','UA','Ukrainian airspace has been closed to civil aviation since February 2022.','KRK,WAW,KIV']
  ];

  /* Cities with several airports. Typing "new york" and being made to choose
   * between JFK, LGA and EWR is a question the traveller cannot answer yet --
   * they want whichever is cheapest at the right time. Several origins for one
   * person is still ONE search, because the provider takes them comma-separated,
   * so searching all three costs nothing extra.
   *
   * Members are listed busiest-first: the request caps origins, so if a list is
   * trimmed the majors survive. */
  var METROS = [
    /* Fourth field: the aliases people type. NYC and LON are real IATA
     * metropolitan codes; the rest are just what gets typed. */
    ['New York', 'US', 'JFK,EWR,LGA', 'NYC,NEW YORK CITY'],
    ['London', 'GB', 'LHR,LGW,STN,LCY,LTN', 'LON'],
    ['Chicago', 'US', 'ORD,MDW', 'CHI'],
    ['Los Angeles', 'US', 'LAX,BUR,SNA,ONT,LGB', 'LA,SOCAL'],
    ['San Francisco Bay Area', 'US', 'SFO,OAK,SJC', 'SF,BAY AREA,SFO BAY'],
    ['Washington', 'US', 'DCA,IAD,BWI', 'WAS,DC,WASHINGTON DC'],
    ['Houston', 'US', 'IAH,HOU'],
    ['Dallas', 'US', 'DFW,DAL'],
    ['Miami', 'US', 'MIA,FLL,PBI', 'SOUTH FLORIDA'],
    ['Paris', 'FR', 'CDG,ORY', 'PAR'],
    ['Milan', 'IT', 'MXP,LIN', 'MIL'],
    ['Rome', 'IT', 'FCO'],
    ['Tokyo', 'JP', 'HND,NRT', 'TYO'],
    ['Seoul', 'KR', 'ICN,GMP'],
    ['Beijing', 'CN', 'PEK,PKX'],
    ['Shanghai', 'CN', 'PVG,SHA'],
    ['Istanbul', 'TR', 'IST,SAW'],
    ['Bangkok', 'TH', 'BKK,DMK'],
    ['Toronto', 'CA', 'YYZ'],
    ['Berlin', 'DE', 'BER'],
    ['Stockholm', 'SE', 'ARN'],
    ['Osaka', 'JP', 'KIX'],
    ['Buenos Aires', 'AR', 'EZE'],
    ['Sao Paulo', 'BR', 'GRU'],
    ['Belfast', 'GB', 'BFS'],
    ['Glasgow', 'GB', 'GLA']
  ].filter(function (r) { return r[2].indexOf(',') > -1; });   // only real multi-airport cities

  var BY_CODE = {};
  /* Where it actually is, for the one question a three-letter code cannot
   * answer: "am I sure I clicked the right airport". ONT is Ontario,
   * California, not Ontario, Canada. PDX is Portland, Oregon, and there is a
   * Portland in Maine. Charleston is South Carolina here, and there is one in
   * West Virginia. A code is a thing people half-remember and the city name
   * alone does not settle it.
   *
   * Keyed by code rather than added to the positional rows, so the 98 existing
   * entries are not retyped -- a transcription slip in a city or an airport
   * name is a wrong answer that looks right.
   *
   * States and provinces only. Everywhere else the country does that job, and
   * is already on the row.
   *
   * Where the airport sits in a different state from the city it serves, this
   * follows the CITY: Reagan National and Dulles are in Virginia and CVG is in
   * Kentucky, but nobody flying to them is going anywhere but Washington and
   * Cincinnati, and the field is there to confirm what the reader meant. */
  var REGION = {
    ABQ: 'New Mexico', ALB: 'New York', ANC: 'Alaska', ATL: 'Georgia',
    AUS: 'Texas', BDL: 'Connecticut', BNA: 'Tennessee', BOI: 'Idaho',
    BOS: 'Massachusetts', BUF: 'New York', BUR: 'California', BWI: 'Maryland',
    CHS: 'South Carolina', CLE: 'Ohio', CLT: 'North Carolina', CMH: 'Ohio',
    COS: 'Colorado', CVG: 'Ohio', DAL: 'Texas', DCA: 'D.C.',
    DEN: 'Colorado', DFW: 'Texas', DSM: 'Iowa', DTW: 'Michigan',
    ELP: 'Texas', EWR: 'New Jersey', FAI: 'Alaska', FAT: 'California',
    FLL: 'Florida', GEG: 'Washington', GRR: 'Michigan', GSP: 'South Carolina',
    HNL: 'Hawaii', HOU: 'Texas', IAD: 'D.C.', IAH: 'Texas',
    ICT: 'Kansas', IND: 'Indiana', JAX: 'Florida', JFK: 'New York',
    KOA: 'Hawaii', LAS: 'Nevada', LAX: 'California', LGA: 'New York',
    LGB: 'California', LIH: 'Hawaii', LIT: 'Arkansas', MCI: 'Missouri',
    MCO: 'Florida', MDW: 'Illinois', MEM: 'Tennessee', MIA: 'Florida',
    MKE: 'Wisconsin', MSN: 'Wisconsin', MSP: 'Minnesota', MSY: 'Louisiana',
    MYR: 'South Carolina', OAK: 'California', OGG: 'Hawaii', OKC: 'Oklahoma',
    OMA: 'Nebraska', ONT: 'California', ORD: 'Illinois', ORF: 'Virginia',
    PBI: 'Florida', PDX: 'Oregon', PHL: 'Pennsylvania', PHX: 'Arizona',
    PIT: 'Pennsylvania', PSP: 'California', PVD: 'Rhode Island',
    RDU: 'North Carolina', RIC: 'Virginia', RNO: 'Nevada', ROC: 'New York',
    RSW: 'Florida', SAN: 'California', SAV: 'Georgia', SEA: 'Washington',
    SFO: 'California', SJC: 'California', SJU: 'Puerto Rico', SLC: 'Utah',
    SMF: 'California', SNA: 'California', SRQ: 'Florida', STL: 'Missouri',
    SYR: 'New York', TPA: 'Florida', TUL: 'Oklahoma', TUS: 'Arizona',
    YEG: 'Alberta', YHZ: 'Nova Scotia', YOW: 'Ontario', YUL: 'Quebec',
    YVR: 'British Columbia', YWG: 'Manitoba', YYC: 'Alberta', YYZ: 'Ontario',
    /* The one city name in this list that exists in two countries, and the
     * exact mistake the field is here to prevent: SJC is San Jose, California
     * and SJO is San Jose, Costa Rica. A country rather than a state, because
     * what disambiguates it is the country -- the field says where it is, not
     * what kind of place name it is. */
    SJO: 'Costa Rica'
  };

  var LIST = A.map(function (r) {
    var o = { code: r[0], city: r[1], name: r[2], country: r[3],
              region: REGION[r[0]] || '', closed: false };
    BY_CODE[r[0]] = o;
    return o;
  });

  var METRO_LIST = METROS.map(function (r) {
    var members = r[2].split(',');
    return { metro: true, city: r[0], country: r[1], members: members,
             aliases: (r[3] || '').split(',').filter(Boolean),
             code: 'ALL', name: 'All airports · ' + members.join(' · ') };
  }).filter(function (m) { return m.members.every(function (c) { return !!BY_CODE[c]; }); });

  CLOSED.forEach(function (r) {
    var o = { code: r[0], city: r[1], name: r[2], country: r[3],
              region: REGION[r[0]] || '', closed: true,
              note: r[4], alternates: r[5] ? r[5].split(',') : [] };
    BY_CODE[r[0]] = o;
    LIST.push(o);
  });

  function get(code) { return BY_CODE[String(code || '').toUpperCase()] || null; }
  function isKnown(code) { return !!get(code); }

  /* Exact code first, then code prefix, then city, then airport name. Ranked so
   * typing "SJ" surfaces SJD/SJC/SJO/SJU before "San Jose del Cabo" matches by
   * name -- the code is what people half-remember. */
  function search(q, limit) {
    var s = String(q || '').trim().toUpperCase();
    if (!s) return [];

    /* A matching city offers "all airports" first, since that is nearly always
     * what someone naming a city means. */
    var metros = METRO_LIST.filter(function (m) {
        return m.city.toUpperCase().indexOf(s) === 0
            || m.members.indexOf(s) > -1
            || m.city.toUpperCase().indexOf(s) > -1
            || m.aliases.some(function (x) { return x.indexOf(s) === 0; });
      }).sort(function (a, b) {
        var ai = a.city.toUpperCase().indexOf(s) === 0 ? 0 : 1;
        var bi = b.city.toUpperCase().indexOf(s) === 0 ? 0 : 1;
        return ai - bi;
      });

    var exact = [], codePre = [], cityPre = [], cityIn = [], nameIn = [];

    for (var i = 0; i < LIST.length; i++) {
      var a = LIST[i];
      var city = a.city.toUpperCase(), name = a.name.toUpperCase();
      if (a.code === s) exact.push(a);
      else if (a.code.indexOf(s) === 0) codePre.push(a);
      else if (city.indexOf(s) === 0) cityPre.push(a);
      else if (city.indexOf(s) > -1) cityIn.push(a);
      else if (name.indexOf(s) > -1) nameIn.push(a);
    }
    /* An exact code match still wins -- typing JFK means JFK. */
    var head = exact.length ? exact.concat(metros) : metros.concat(exact);
    return head.concat(codePre, cityPre, cityIn, nameIn).slice(0, limit || 8);
  }

  var api = { LIST: LIST, METROS: METRO_LIST, get: get, isKnown: isKnown, search: search };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AIRPORTS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
