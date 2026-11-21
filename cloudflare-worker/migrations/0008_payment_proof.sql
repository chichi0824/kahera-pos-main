-- Store compressed payment confirmation photos with their orders.
ALTER TABLE orders ADD COLUMN payment_proof TEXT;
