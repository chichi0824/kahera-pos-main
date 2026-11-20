/**
 * Kahera POS — menu-sample.js
 * Official shared menu. Updated by the authenticated Kahera admin API.
 * Prices are VAT-inclusive and stored in centavos.
 */
(function (root) {
  "use strict";
  root.KAHERA_SAMPLE = {
    settings: {
      bizName: "Karinderya ng",
      bizNote: "Sta. Cruz, Laguna",
      vatRegistered: true,
    },
    categories: [
      {
        id: "drinks",
        name: "Drinks",
      },
      {
        id: "meals",
        name: "Ulam",
      },
      {
        id: "merienda",
        name: "Merienda",
      },
      {
        id: "extras",
        name: "Extras",
      },
    ],
    menu: [
      {
        id: "m15",
        cat: "extras",
        name: "Fried Egg",
        price: 1800,
        available: true,
      },
    ],
    orders: [
      [
        410,
        "dine",
        "2",
        [
          ["m07", 2],
          ["m01", 2],
        ],
        "cash",
        "none",
        2,
        0,
      ],
      [372, "take", "", [["m12", 6]], "ewallet", "none", 1, 0],
      [
        298,
        "dine",
        "5",
        [
          ["m05", 1],
          ["m06", 1],
          ["m14", 2],
          ["m04", 2],
        ],
        "cash",
        "senior",
        2,
        1,
      ],
      [
        221,
        "dine",
        "1",
        [
          ["m11", 2],
          ["m03", 1],
        ],
        "card",
        "none",
        2,
        0,
      ],
      [
        150,
        "take",
        "",
        [
          ["m02", 3],
          ["m10", 3],
        ],
        "ewallet",
        "none",
        1,
        0,
      ],
      [
        64,
        "dine",
        "3",
        [
          ["m08", 1],
          ["m01", 1],
        ],
        "cash",
        "pwd",
        1,
        1,
      ],
    ],
  };
})(typeof self !== "undefined" ? self : this);
