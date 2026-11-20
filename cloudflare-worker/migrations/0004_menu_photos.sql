-- Rename the old category and store compressed menu item photos.
UPDATE menu_categories SET name='Ulam' WHERE id='meals' OR lower(name)='rice meals';
ALTER TABLE menu_items ADD COLUMN image_data TEXT;
