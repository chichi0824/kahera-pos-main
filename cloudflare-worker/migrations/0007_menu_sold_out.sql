-- Add a separate sold-out flag. Available=false means not offered today;
-- sold_out=true means offered today but temporarily out of stock.
ALTER TABLE menu_items ADD COLUMN sold_out INTEGER NOT NULL DEFAULT 0 CHECK (sold_out IN (0,1));
