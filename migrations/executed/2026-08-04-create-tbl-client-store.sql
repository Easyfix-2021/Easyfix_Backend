-- Client store / branch directory.
--
-- Powers the "book by store code" flow on the client New Order form: a SPOC
-- types their store code and the store's name + contact + address auto-fill,
-- so they only enter the service, description and appointment.
--
-- One row per (client, store_code). Additive — no existing table is touched.
CREATE TABLE IF NOT EXISTS tbl_client_store (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  fk_client_id  INT           NOT NULL,
  store_code    VARCHAR(64)   NOT NULL,
  store_name    VARCHAR(255)  NULL,
  contact_name  VARCHAR(255)  NULL,
  contact_no    VARCHAR(20)   NULL,
  address       TEXT          NULL,
  city_id       INT           NULL,
  city_name     VARCHAR(120)  NULL,
  pin_code      VARCHAR(12)   NULL,
  status        TINYINT       NOT NULL DEFAULT 1,   -- 1 = active, 0 = inactive
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_client_store_code (fk_client_id, store_code),
  KEY idx_client_store_client (fk_client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
